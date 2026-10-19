export const feedbackStatuses = [
  'new', 'under_review', 'planned', 'in_progress', 'awaiting_user_reply', 'implemented', 'resolved', 'rejected', 'closed',
];
export const feedbackPriorities = ['low', 'medium', 'high', 'critical'];
const schemaInitialization = new WeakMap();

export const feedbackSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS feedback_submissions (
    id TEXT PRIMARY KEY,
    ticket_number INTEGER NOT NULL UNIQUE,
    access_token_hash TEXT,
    type TEXT NOT NULL CHECK (type IN ('suggestion', 'issue')),
    game_id TEXT,
    message TEXT NOT NULL,
    device_info TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'under_review', 'planned', 'in_progress', 'awaiting_user_reply', 'implemented', 'resolved', 'rejected', 'closed')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    admin_notes TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS feedback_created_at ON feedback_submissions (created_at)',
  'CREATE INDEX IF NOT EXISTS feedback_status_created ON feedback_submissions (status, created_at)',
  `CREATE TABLE IF NOT EXISTS feedback_ticket_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_number INTEGER NOT NULL
  )`,
  'INSERT OR IGNORE INTO feedback_ticket_sequence (id, next_number) SELECT 1, COALESCE(MAX(ticket_number), 1000) + 1 FROM feedback_submissions',
  `CREATE TABLE IF NOT EXISTS feedback_conversations (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'admin')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS feedback_conversation_ticket ON feedback_conversations (feedback_id, created_at)',
  `CREATE TABLE IF NOT EXISTS feedback_activity (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin')),
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS feedback_activity_ticket ON feedback_activity (feedback_id, created_at)',
  `CREATE TABLE IF NOT EXISTS feedback_rate_limits (
    client_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL
  )`,
];

export const legacyFeedbackMigrationStatements = [
  `CREATE TABLE feedback_submissions_new (
    id TEXT PRIMARY KEY,
    ticket_number INTEGER NOT NULL UNIQUE,
    access_token_hash TEXT,
    type TEXT NOT NULL CHECK (type IN ('suggestion', 'issue')),
    game_id TEXT,
    message TEXT NOT NULL,
    device_info TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'under_review', 'planned', 'in_progress', 'awaiting_user_reply', 'implemented', 'resolved', 'rejected', 'closed')),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    admin_notes TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `INSERT INTO feedback_submissions_new (
    id, ticket_number, access_token_hash, type, game_id, message, device_info,
    status, priority, admin_notes, archived_at, deleted_at, created_at, updated_at
  )
  SELECT
    id,
    1000 + ROW_NUMBER() OVER (ORDER BY created_at, id),
    NULL,
    type,
    game_id,
    message,
    device_info,
    CASE status
      WHEN 'seen' THEN 'under_review'
      WHEN 'working' THEN 'in_progress'
      WHEN 'important' THEN 'under_review'
      WHEN 'archived' THEN 'closed'
      ELSE status
    END,
    CASE WHEN status = 'important' THEN 'high' ELSE 'medium' END,
    admin_notes,
    CASE WHEN status = 'archived' THEN updated_at ELSE NULL END,
    NULL,
    created_at,
    updated_at
  FROM feedback_submissions`,
  'DROP TABLE feedback_submissions',
  'ALTER TABLE feedback_submissions_new RENAME TO feedback_submissions',
  'CREATE INDEX feedback_created_at ON feedback_submissions (created_at)',
  'CREATE INDEX feedback_status_created ON feedback_submissions (status, created_at)',
  'CREATE INDEX feedback_ticket_number ON feedback_submissions (ticket_number)',
  'CREATE INDEX feedback_archived_status ON feedback_submissions (archived_at, status)',
  'CREATE INDEX feedback_deleted ON feedback_submissions (deleted_at)',
  `CREATE TABLE feedback_ticket_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_number INTEGER NOT NULL
  )`,
  `INSERT INTO feedback_ticket_sequence (id, next_number)
    SELECT 1, COALESCE(MAX(ticket_number), 1000) + 1 FROM feedback_submissions`,
  `CREATE TABLE feedback_conversations (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'admin')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX feedback_conversation_ticket ON feedback_conversations (feedback_id, created_at)',
  `CREATE TABLE feedback_activity (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin')),
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX feedback_activity_ticket ON feedback_activity (feedback_id, created_at)',
];

async function feedbackColumns(database) {
  const result = await database.prepare('PRAGMA table_info(feedback_submissions)').all();
  return result.results || [];
}

function isLegacyFeedbackSchema(columns) {
  return columns.length > 0 && !columns.some((column) => column.name === 'ticket_number');
}

export async function ensureFeedbackSchema(database) {
  let initialization = schemaInitialization.get(database);
  if (!initialization) {
    initialization = (async () => {
      let columns = await feedbackColumns(database);
      if (isLegacyFeedbackSchema(columns)) {
        if (typeof database.batch !== 'function') {
          throw new Error('The admin database cannot safely upgrade the legacy feedback schema.');
        }
        try {
          const results = await database.batch(legacyFeedbackMigrationStatements.map((sql) => database.prepare(sql)));
          if (results.some((result) => result?.success === false)) {
            throw new Error('Could not upgrade the legacy feedback schema.');
          }
        } catch (error) {
          columns = await feedbackColumns(database);
          if (columns.length === 0 || isLegacyFeedbackSchema(columns)) throw error;
        }
      }
      for (const sql of feedbackSchemaStatements) {
        const result = await database.prepare(sql).run();
        if (result?.success === false) throw new Error('Could not initialize feedback storage.');
      }
    })();
    schemaInitialization.set(database, initialization);
  }
  try {
    await initialization;
  } catch (error) {
    schemaInitialization.delete(database);
    throw error;
  }
}

const maximumMessageLength = 5000;
const deviceValues = {
  deviceType: new Set(['Desktop', 'Mobile', 'Tablet', 'Unknown']),
  operatingSystem: new Set(['Windows', 'Android', 'iOS', 'macOS', 'Linux', 'Unknown']),
  browser: new Set(['Edge', 'Opera', 'Samsung Internet', 'Firefox', 'Chrome', 'Safari', 'Unknown']),
};
const deviceTextFields = ['deviceName', 'browserVersion', 'operatingSystemVersion', 'language', 'timezone'];

export function validateFeedbackSubmission(body, games) {
  if (!['suggestion', 'issue'].includes(body.type)) {
    throw Object.assign(new Error('Choose Suggestion or Issue.'), { status: 400 });
  }
  if (typeof body.message !== 'string') {
    throw Object.assign(new Error('Message is required and must be 5,000 characters or fewer.'), { status: 400 });
  }
  const message = body.message.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!message || message.length > maximumMessageLength) {
    throw Object.assign(new Error('Message is required and must be 5,000 characters or fewer.'), { status: 400 });
  }
  if (body.gameId !== undefined && body.gameId !== null && body.gameId !== ''
    && (typeof body.gameId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.gameId))) {
    throw Object.assign(new Error('Choose a valid game from the library.'), { status: 400 });
  }
  const gameId = body.type === 'issue' && typeof body.gameId === 'string' && body.gameId ? body.gameId : null;
  if (gameId && !games.some((game) => game.id === gameId && game.status === 'published')) {
    throw Object.assign(new Error('Choose a game from the current public library.'), { status: 400 });
  }
  const deviceInfo = {};
  if (body.deviceInfo && typeof body.deviceInfo === 'object' && !Array.isArray(body.deviceInfo)) {
    for (const [key, values] of Object.entries(deviceValues)) {
      const value = body.deviceInfo[key];
      if (typeof value === 'string' && values.has(value)) deviceInfo[key] = value;
    }
    for (const key of deviceTextFields) {
      const value = body.deviceInfo[key];
      if (typeof value === 'string') deviceInfo[key] = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 100);
    }
    const resolution = body.deviceInfo.screenResolution;
    if (typeof resolution === 'string' && /^\d{1,5} × \d{1,5}$/.test(resolution)) deviceInfo.screenResolution = resolution;
    const version = body.deviceInfo.octoVersion;
    if (typeof version === 'string') deviceInfo.octoVersion = version.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 100);
  }
  return { type: body.type, gameId, message, deviceInfo };
}

export function normalizeFeedback(row) {
  const legacyStatuses = { seen: 'under_review', working: 'in_progress', important: 'under_review', archived: 'closed' };
  return {
    id: row.id,
    ticketNumber: row.ticket_number || null,
    userAccessEnabled: Boolean(row.access_token_hash),
    type: row.type,
    gameId: row.game_id,
    message: row.message,
    deviceInfo: JSON.parse(row.device_info || '{}'),
    status: legacyStatuses[row.status] || row.status,
    priority: row.priority || 'medium',
    archived: Boolean(row.archived_at),
    deleted: Boolean(row.deleted_at),
    adminNotes: row.admin_notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateFeedbackStatus(status) {
  if (!feedbackStatuses.includes(status)) {
    throw Object.assign(new Error('Choose a valid feedback status.'), { status: 400 });
  }
  return status;
}

export function validateFeedbackPriority(priority) {
  if (!feedbackPriorities.includes(priority)) {
    throw Object.assign(new Error('Choose a valid ticket priority.'), { status: 400 });
  }
  return priority;
}

export function validateAdminNotes(value) {
  if (typeof value !== 'string' || value.length > 5000) {
    throw Object.assign(new Error('Admin notes must be 5,000 characters or fewer.'), { status: 400 });
  }
  return value.trim();
}

export function validateConversationMessage(value) {
  if (typeof value !== 'string') {
    throw Object.assign(new Error('A reply is required and must be 5,000 characters or fewer.'), { status: 400 });
  }
  const message = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!message || message.length > 5000) {
    throw Object.assign(new Error('A reply is required and must be 5,000 characters or fewer.'), { status: 400 });
  }
  return message;
}
