import type {
  AppSettings,
  AuditLogEntry,
  AuditVerifyResult,
  CreateTripOutPayload,
  DashboardData,
  Driver,
  FuelLevel,
  NotificationChannel,
  NotificationRecipient,
  NotificationRecord,
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
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let inMemorySessionToken: string | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
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
    if (res.status === 401) {
      inMemorySessionToken = null;
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
  me: () => request<{ user: UserPublic }>('/auth/me'),

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
    if (res.sessionToken) inMemorySessionToken = res.sessionToken;
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
    if (res.sessionToken) inMemorySessionToken = res.sessionToken;
    return res;
  },

  logout: async () => {
    try {
      return await request<{ ok: boolean }>('/auth/logout', {
        method: 'POST',
      });
    } finally {
      inMemorySessionToken = null;
    }
  },

  changePin: async (currentPin: string, newPin: string) => {
    const res = await request<{ user: UserPublic; sessionToken?: string }>('/auth/change-pin', {
      method: 'POST',
      body: JSON.stringify({ currentPin, newPin }),
    });
    if (res.sessionToken) inMemorySessionToken = res.sessionToken;
    return res;
  },

  getSettings: () => request<{ settings: AppSettings }>('/settings'),

  updateSettings: (settings: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

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
    licence_number: string;
    phone: string;
    address: string;
    licence_expiry: string | null;
  }) =>
    request<{ driver: Driver }>('/drivers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateDriver: (
    id: number,
    payload: {
      full_name?: string;
      licence_number?: string;
      phone?: string;
      address?: string;
      licence_expiry?: string | null;
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
    request<{ unreadCount: number; highUnreadCount: number }>('/notifications/unread-count'),

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
};


