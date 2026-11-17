import type { AuditLogEntry, AuditVerifyResult } from '../shared/types';
import { sha256Hex } from './crypto';
import type { D1DatabaseLike } from './types';

export interface AuditInput {
  userId: number | null;
  username: string;
  userRole: string;
  action: string;
  entity: string;
  entityId: string | number;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
  userAgent?: string;
  ts?: string;
}

export async function computeAuditRowHash(params: {
  prevHash: string;
  ts: string;
  userId: number | null;
  username: string;
  userRole: string;
  action: string;
  entity: string;
  entityId: string;
  oldJson: string | null;
  newJson: string | null;
  ip: string;
  userAgent: string;
}): Promise<string> {
  const canonical = JSON.stringify([
    params.prevHash,
    params.ts,
    params.userId ?? null,
    params.username,
    params.userRole,
    params.action,
    params.entity,
    params.entityId,
    params.oldJson ?? null,
    params.newJson ?? null,
    params.ip,
    params.userAgent,
  ]);
  return sha256Hex(canonical);
}

export async function recordAudit(db: D1DatabaseLike, input: AuditInput): Promise<void> {
  const ts = input.ts ?? new Date().toISOString();
  const entityId = String(input.entityId);
  const oldJson = input.oldValue !== undefined && input.oldValue !== null ? JSON.stringify(input.oldValue) : null;
  const newJson = input.newValue !== undefined && input.newValue !== null ? JSON.stringify(input.newValue) : null;
  const ip = input.ip ?? '';
  const userAgent = (input.userAgent ?? '').slice(0, 300);

  const lastRow = await db
    .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
    .first<{ hash: string }>();

  const prevHash = lastRow?.hash ?? 'GENESIS';
  const hash = await computeAuditRowHash({
    prevHash,
    ts,
    userId: input.userId,
    username: input.username,
    userRole: input.userRole,
    action: input.action,
    entity: input.entity,
    entityId,
    oldJson,
    newJson,
    ip,
    userAgent,
  });

  await db
    .prepare(
      `INSERT INTO audit_log
       (ts, user_id, username, user_role, action, entity, entity_id, old_json, new_json, ip, user_agent, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ts,
      input.userId,
      input.username,
      input.userRole,
      input.action,
      input.entity,
      entityId,
      oldJson,
      newJson,
      ip,
      userAgent,
      prevHash,
      hash
    )
    .run();
}

export async function verifyAuditChain(db: D1DatabaseLike): Promise<AuditVerifyResult> {
  const { results } = await db
    .prepare(
      `SELECT id, ts, user_id, username, user_role, action, entity, entity_id, old_json, new_json, ip, user_agent, prev_hash, hash
       FROM audit_log ORDER BY id ASC`
    )
    .all<AuditLogEntry>();

  const checkedAt = new Date().toISOString();
  let expectedPrevHash = 'GENESIS';

  for (const row of results) {
    if (row.prev_hash !== expectedPrevHash) {
      return {
        ok: false,
        totalRows: results.length,
        checkedAt,
        brokenRowId: row.id,
        reason: `Row #${row.id} previous-hash link mismatch (expected ${expectedPrevHash.slice(0, 12)}..., found ${row.prev_hash.slice(0, 12)}...).`,
      };
    }

    const recomputed = await computeAuditRowHash({
      prevHash: row.prev_hash,
      ts: row.ts,
      userId: row.user_id,
      username: row.username,
      userRole: row.user_role,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      oldJson: row.old_json,
      newJson: row.new_json,
      ip: row.ip,
      userAgent: row.user_agent,
    });

    if (recomputed !== row.hash) {
      return {
        ok: false,
        totalRows: results.length,
        checkedAt,
        brokenRowId: row.id,
        reason: `Row #${row.id} content hash mismatch — record content was altered after creation.`,
      };
    }

    expectedPrevHash = row.hash;
  }

  return {
    ok: true,
    totalRows: results.length,
    checkedAt,
  };
}
