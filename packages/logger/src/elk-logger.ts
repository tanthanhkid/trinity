import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as winston from 'winston'

export interface ElkLoggerOptions {
  service: string
  elasticsearchUrl?: string
  level?: string
}

function getLogDir(): string {
  const defaultDir = '/var/log/trinity'
  try {
    fs.mkdirSync(defaultDir, { recursive: true })
    return defaultDir
  } catch {
    const localDir = path.join(os.tmpdir(), 'trinity-logs')
    fs.mkdirSync(localDir, { recursive: true })
    return localDir
  }
}

/**
 * Flatten multiline stack traces into a single line so each JSON log entry
 * stays on one line (ndjson). Replaces literal newlines with " | ".
 * Also handles error_stack from manual meta objects (e.g. exception filter).
 */
function flattenStackTrace(): winston.Logform.Format {
  return winston.format((info) => {
    if (typeof info.stack === 'string') {
      info.stack = info.stack.replace(/\n/g, ' | ')
    }
    if (typeof info.error_stack === 'string') {
      info.error_stack = info.error_stack.replace(/\n/g, ' | ')
    }
    if (typeof info.trace === 'string') {
      info.trace = info.trace.replace(/\n/g, ' | ')
    }
    return info
  })()
}

export function createElkLogger(options: ElkLoggerOptions): winston.Logger {
  const { service, level = 'info' } = options
  const serverless = process.env.TRINITY_RUNTIME?.trim().toLowerCase() === 'serverless'
  const elasticsearchUrl = options.elasticsearchUrl || process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
  // Serverless: chỉ ghi console (Vercel gom stdout) — không file (đĩa chỉ đọc), không ES (không có Elasticsearch).
  const logDir = serverless ? '' : getLogDir()

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level: lvl, message, service: svc, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
          return `[${timestamp}] [${svc}] ${lvl}: ${message}${metaStr}`
        }),
      ),
    }),
  ]

  if (serverless) {
    const lean = winston.createLogger({ level, defaultMeta: { service }, transports })
    lean.on('error', () => undefined)
    return lean
  }

  // JSON file transport for Filebeat pickup (primary ELK ingestion)
  // Each log entry MUST be a single JSON object on one line (ndjson).
  // - errors() ensures Error objects are serialized inline (no split writes)
  // - Custom format flattens multiline stack traces into single-line strings
  // - json() with explicit eol guarantees newline-delimited output
  transports.push(
    new winston.transports.File({
      filename: `${logDir}/${service}.log`,
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 5,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        flattenStackTrace(),
        winston.format.json(),
      ),
    }),
  )

  // Direct Elasticsearch transport (fallback, used when Filebeat is not available)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ElasticsearchTransport } = require('winston-elasticsearch')
    const esTransport = new ElasticsearchTransport({
      level: 'info',
      clientOpts: { node: elasticsearchUrl },
      indexPrefix: 'trinity-logs',
      indexSuffixPattern: 'YYYY.MM.DD',
      transformer: (logData: Record<string, unknown>) => {
        return {
          '@timestamp': logData.timestamp || new Date().toISOString(),
          severity: logData.level,
          message: logData.message,
          service,
          fields: logData.meta,
        }
      },
    })
    esTransport.on('error', () => {
      // Silently ignore ES connection errors - logs still go to console + file
    })
    transports.push(esTransport)
  } catch {
    // winston-elasticsearch not available, skip
  }

  const logger = winston.createLogger({
    level,
    defaultMeta: { service },
    transports,
  })

  // Prevent unhandled 'error' events from crashing the process.
  // Winston re-emits transport errors on the logger instance.
  logger.on('error', () => {
    // Silently ignore - logs still go to console + file
  })

  return logger
}
