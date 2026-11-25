import type {
  AppSettings,
  AuditLogEntry,
  AuditVerifyResult,
  CreateTripOutPayload,
  DashboardData,
  Driver,
  FleetMaintenanceOverview,
  FuelLevel,
  GarageVisit,
  GarageVisitStatus,
  MaintenanceRecordType,
  NotificationChannel,
  NotificationRecipient,
  NotificationRecord,
  PartsPurchaseRequest,
  ReportPreviewData,
  ReportType,
  ExportFormat,
  Role,
  TripCorrection,
  TripDetail,
  TripSummary,
  TripType,
  UserPublic,
  Vehicle,
  VehicleCondition,
  VehicleMaintenanceLog,
  VehicleServiceDueSummary,
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SESSION_TOKEN_KEY = 'fleet_secure_session_token';
const CACHED_USER_KEY = 'fleet_secure_cached_user';
const CACHED_SETTINGS_KEY = 'fleet_secure_cached_settings';

function readStoredToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

let inMemorySessionToken: string | null = readStoredToken();

function setSessionToken(token: string | null): void {
  inMemorySessionToken = token;
  try {
    if (typeof localStorage === 'undefined') return;
    if (token) {
      localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function getCachedUser(): UserPublic | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserPublic;
  } catch {
    return null;
  }
}

export function setCachedUser(user: UserPublic | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (user) {
      localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(CACHED_USER_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getCachedSettings(): AppSettings | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHED_SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppSettings;
  } catch {
    return null;
  }
}

export function setCachedSettings(settings: AppSettings | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (settings) {
      localStorage.setItem(CACHED_SETTINGS_KEY, JSON.stringify(settings));
    } else {
      localStorage.removeItem(CACHED_SETTINGS_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearCachedSession(): void {
  setSessionToken(null);
  setCachedUser(null);
}

export async function checkServerReachable(timeoutMs = 3000): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = inMemorySessionToken ?? readStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const isHtml = /^\s*</.test(text);
      data = {
        error: isHtml
          ? `Server returned an unexpected ${res.status} error. Please reload the page and try again.`
          : text,
      };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      clearCachedSession();
    }
    const msg =
      typeof data.error === 'string' && data.error.trim()
        ? data.error
        : 'Something went wrong. Please try again.';
    throw new ApiError(msg, res.status);
  }

  return data as T;
}

export const api = {
  me: async () => {
    const res = await request<{ user: UserPublic }>('/auth/me');
    setCachedUser(res.user);
    return res;
  },

  getPreviewStatus: () =>
    request<{
      previewSignupEnabled: boolean;
      vehicleCount: number;
      driverCount: number;
      tripCount: number;
    }>('/auth/preview-status'),

  signupAdmin: async (payload: {
    full_name: string;
    username: string;
    pin: string;
    load_demo_data: boolean;
  }) => {
    const res = await request<{
      user: UserPublic;
      demoSeeded: { vehiclesAdded: number; driversAdded: number; tripsAdded: number } | null;
      sessionToken?: string;
    }>('/auth/signup-admin', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    setCachedUser(res.user);
    return res;
  },

  seedDemoData: () =>
    request<{ ok: boolean; vehiclesAdded: number; driversAdded: number; tripsAdded: number }>(
      '/demo/seed',
      { method: 'POST' }
    ),

  login: async (username: string, pin: string) => {
    const res = await request<{ user: UserPublic; sessionToken?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, pin }),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    setCachedUser(res.user);
    return res;
  },

  logout: async () => {
    try {
      return await request<{ ok: boolean }>('/auth/logout', {
        method: 'POST',
      });
    } finally {
      clearCachedSession();
    }
  },

  changePin: async (currentPin: string, newPin: string) => {
    const res = await request<{ user: UserPublic; sessionToken?: string }>('/auth/change-pin', {
      method: 'POST',
      body: JSON.stringify({ currentPin, newPin }),
    });
    if (res.sessionToken) setSessionToken(res.sessionToken);
    setCachedUser(res.user);
    return res;
  },

  getSettings: async () => {
    const res = await request<{ settings: AppSettings }>('/settings');
    setCachedSettings(res.settings);
    return res;
  },

  updateSettings: async (settings: Partial<AppSettings>) => {
    const res = await request<{ settings: AppSettings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    setCachedSettings(res.settings);
    return res;
  },

  listUsers: (params: { q?: string; page?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ items: UserPublic[]; total: number; page: number; limit: number }>(
      `/users?${qs.toString()}`
    );
  },

  createUser: (payload: { username: string; full_name: string; role: Role; pin: string }) =>
    request<{ user: UserPublic }>('/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateUser: (
    id: number,
    payload: { full_name?: string; role?: Role; active?: boolean; resetPin?: string }
  ) =>
    request<{ user: UserPublic }>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  listAuditLog: (
    params: { q?: string; action?: string; entity?: string; page?: number; limit?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.action) qs.set('action', params.action);
    if (params.entity) qs.set('entity', params.entity);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ items: AuditLogEntry[]; total: number; page: number; limit: number }>(
      `/audit-log?${qs.toString()}`
    );
  },

  verifyAuditChain: () =>
    request<{ result: AuditVerifyResult }>('/audit-log/verify', {
      method: 'POST',
    }),

  listVehicles: (
    params: {
      q?: string;
      status?: string;
      condition?: string;
      vehicle_class?: string;
      includeInactive?: boolean;
      page?: number;
      limit?: number;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.condition) qs.set('condition', params.condition);
    if (params.vehicle_class) qs.set('vehicle_class', params.vehicle_class);
    if (params.includeInactive) qs.set('includeInactive', '1');
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ items: Vehicle[]; total: number; page: number; limit: number }>(
      `/vehicles?${qs.toString()}`
    );
  },

  getVehicle: (id: number) =>
    request<{
      vehicle: Vehicle;
      trips: Array<{
        id: number;
        trip_type: 'HIRE' | 'ERRAND';
        status: 'OPEN' | 'CLOSED';
        driver_name: string;
        client_name: string | null;
        destination: string | null;
        out_at: string | null;
        in_at: string | null;
        days_hired: number | null;
        expected_return_date: string | null;
        mileage_out: number | null;
        mileage_in: number | null;
        total_mileage: number | null;
      }>;
      conditionHistory: AuditLogEntry[];
    }>(`/vehicles/${id}`),

  createVehicle: (payload: {
    reg_number: string;
    vehicle_type: string;
    make_model: string;
    condition: VehicleCondition;
    last_known_mileage: number;
    next_service_due_km?: number | null;
  }) =>
    request<{ vehicle: Vehicle }>('/vehicles', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateVehicle: (
    id: number,
    payload: {
      reg_number?: string;
      vehicle_type?: string;
      make_model?: string;
      condition?: VehicleCondition;
      last_known_mileage?: number;
      next_service_due_km?: number | null;
      active?: boolean;
    }
  ) =>
    request<{ vehicle: Vehicle }>(`/vehicles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  listDrivers: (
    params: {
      q?: string;
      status?: string;
      expiring?: boolean;
      includeInactive?: boolean;
      page?: number;
      limit?: number;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.expiring) qs.set('expiring', '1');
    if (params.includeInactive) qs.set('includeInactive', '1');
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{
      items: Driver[];
      total: number;
      expiringCount: number;
      missingDocsCount?: number;
      page: number;
      limit: number;
    }>(`/drivers?${qs.toString()}`);
  },

  getDriver: (id: number) =>
    request<{
      driver: Driver;
      trips: Array<{
        id: number;
        trip_type: 'HIRE' | 'ERRAND';
        status: 'OPEN' | 'CLOSED';
        reg_number: string;
        make_model: string;
        client_name: string | null;
        destination: string | null;
        out_at: string | null;
        in_at: string | null;
        days_hired: number | null;
        expected_return_date: string | null;
        total_mileage: number | null;
      }>;
    }>(`/drivers/${id}`),

  createDriver: (payload: {
    full_name: string;
    licence_number?: string | null;
    licence_code?: string | null;
    phone: string;
    address?: string;
    licence_expiry?: string | null;
    licence_document?: string | null;
    ddc_number?: string | null;
    ddc_document?: string | null;
    retest_cert_number?: string | null;
    retest_document?: string | null;
    medical_cert_number?: string | null;
    medical_document?: string | null;
  }) =>
    request<{ driver: Driver }>('/drivers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateDriver: (
    id: number,
    payload: {
      full_name?: string;
      licence_number?: string | null;
      licence_code?: string | null;
      phone?: string;
      address?: string;
      licence_expiry?: string | null;
      licence_document?: string | null;
      ddc_number?: string | null;
      ddc_document?: string | null;
      retest_cert_number?: string | null;
      retest_document?: string | null;
      medical_cert_number?: string | null;
      medical_document?: string | null;
      active?: boolean;
    }
  ) =>
    request<{ driver: Driver }>(`/drivers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  listTrips: (
    params: {
      status?: 'OPEN' | 'CLOSED' | '';
      trip_type?: TripType | '';
      vehicle_id?: number;
      driver_id?: number;
      flagged?: boolean;
      from?: string;
      to?: string;
      q?: string;
      page?: number;
      limit?: number;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.trip_type) qs.set('trip_type', params.trip_type);
    if (params.vehicle_id) qs.set('vehicle_id', String(params.vehicle_id));
    if (params.driver_id) qs.set('driver_id', String(params.driver_id));
    if (params.flagged) qs.set('flagged', '1');
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ items: TripSummary[]; total: number; page: number; limit: number }>(
      `/trips?${qs.toString()}`
    );
  },

  getTrip: (id: number) => request<TripDetail>(`/trips/${id}`),

  createTripOut: (payload: CreateTripOutPayload) =>
    request<{ trip: TripSummary; flags: TripSummary['flags'] }>('/trips/out', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  createTripIn: (
    tripId: number,
    payload: {
      mileage_in: number;
      fuel_in: FuelLevel;
      closing_checklist_by: string;
      notes?: string;
      device_time?: string;
    }
  ) =>
    request<{ trip: TripSummary; flags: TripSummary['flags'] }>(`/trips/${tripId}/in`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  createTripCorrection: (
    tripId: number,
    payload: {
      target_table: 'trips' | 'trip_out' | 'trip_in';
      field_changes: Record<string, unknown>;
      reason: string;
    }
  ) =>
    request<{ correction: TripCorrection }>(`/trips/${tripId}/corrections`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getDashboard: (params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<DashboardData>(`/dashboard${suffix}`);
  },

  getUnreadNotificationsCount: () =>
    request<{
      unreadCount: number;
      highUnreadCount: number;
      latestUnread?: NotificationRecord[];
    }>('/notifications/unread-count'),

  listNotifications: (
    params: { unreadOnly?: boolean; priority?: 'HIGH' | 'NORMAL' | ''; page?: number; limit?: number } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.unreadOnly) qs.set('unreadOnly', '1');
    if (params.priority) qs.set('priority', params.priority);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{
      items: NotificationRecord[];
      total: number;
      unreadCount: number;
      page: number;
      limit: number;
    }>(`/notifications${suffix}`);
  },

  markNotificationRead: (id: number) =>
    request<{ notification: NotificationRecord }>(`/notifications/${id}/read`, {
      method: 'POST',
    }),

  markAllNotificationsRead: () =>
    request<{ ok: boolean; updated: number }>('/notifications/read-all', {
      method: 'POST',
    }),

  checkOverdueHires: () =>
    request<{ checked: number; newlyNotified: number }>('/notifications/check-overdue', {
      method: 'POST',
    }),

  listNotificationRecipients: () =>
    request<{
      items: NotificationRecipient[];
      managers: Array<{ id: number; username: string; full_name: string; role: Role }>;
      emailConfigured: boolean;
    }>('/notification-recipients'),

  upsertNotificationRecipient: (payload: {
    user_id: number;
    channel: NotificationChannel;
    destination: string;
    active?: boolean;
  }) =>
    request<{ recipient: NotificationRecipient }>('/notification-recipients', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateNotificationRecipient: (id: number, payload: { destination?: string; active?: boolean }) =>
    request<{ recipient: NotificationRecipient }>(`/notification-recipients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteNotificationRecipient: (id: number) =>
    request<{ ok: boolean }>(`/notification-recipients/${id}`, {
      method: 'DELETE',
    }),

  getReportPreview: (params: { type: ReportType; from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    qs.set('type', params.type);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return request<ReportPreviewData>(`/reports/preview?${qs.toString()}`);
  },

  getReportExportUrl: (params: {
    type: ReportType;
    format: ExportFormat;
    from?: string;
    to?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('type', params.type);
    qs.set('format', params.format);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return `/api/reports/export?${qs.toString()}`;
  },

  getFleetMaintenanceOverview: (vehicleId?: number) => {
    const suffix = vehicleId ? `?vehicle_id=${vehicleId}` : '';
    return request<FleetMaintenanceOverview>(`/fleet-maintenance/overview${suffix}`);
  },

  createMaintenanceLog: (payload: {
    vehicle_id: number;
    record_type: MaintenanceRecordType;
    service_date: string;
    odometer_km: number;
    summary: string;
    details?: string;
    workshop_name?: string;
    cost?: number | null;
    next_service_due_km?: number | null;
  }) =>
    request<{ log: VehicleMaintenanceLog }>('/fleet-maintenance/logs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateVehicleNextService: (vehicleId: number, next_service_due_km: number | null) =>
    request<{ vehicle: Vehicle; serviceDue: VehicleServiceDueSummary }>(
      `/fleet-maintenance/next-service/${vehicleId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ next_service_due_km }),
      }
    ),

  createGarageVisit: (payload: {
    vehicle_id: number;
    visit_date: string;
    workshop_name: string;
    reason: string;
    odometer_km: number;
    estimated_cost?: number | null;
    notes?: string;
  }) =>
    request<{ visit: GarageVisit }>('/fleet-maintenance/garage-visits', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  decideGarageVisit: (
    id: number,
    payload: { decision: 'APPROVED' | 'REJECTED'; approval_notes?: string }
  ) =>
    request<{ visit: GarageVisit }>(`/fleet-maintenance/garage-visits/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateGarageVisitStatus: (
    id: number,
    payload: { visit_status: GarageVisitStatus; actual_cost?: number | null; notes?: string }
  ) =>
    request<{ visit: GarageVisit }>(`/fleet-maintenance/garage-visits/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  createPartsRequest: (payload: {
    request_date: string;
    vehicle_id?: number;
    new_vehicle?: {
      reg_number: string;
      vehicle_type: string;
      make_model: string;
      condition?: VehicleCondition;
      last_known_mileage: number;
    };
    parts_required: string;
    is_full_service_kit: boolean;
    date_required: string;
    estimated_amount: number;
    quotation_file?: string | null;
    quotation_filename?: string | null;
  }) =>
    request<{ request: PartsPurchaseRequest; createdVehicle?: Vehicle }>(
      '/fleet-maintenance/parts-requests',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  getPartsRequestQuotation: (id: number) =>
    request<{ quotation_file: string; quotation_filename: string }>(
      `/fleet-maintenance/parts-requests/${id}/quotation`
    ),

  decidePartsRequest: (
    id: number,
    payload: { decision: 'APPROVED' | 'REJECTED' | 'PURCHASED'; admin_notes?: string }
  ) =>
    request<{ request: PartsPurchaseRequest }>(`/fleet-maintenance/parts-requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  markPartsRequestPurchased: (id: number) =>
    request<{ request: PartsPurchaseRequest }>(`/fleet-maintenance/parts-requests/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'PURCHASED' }),
    }),
};
