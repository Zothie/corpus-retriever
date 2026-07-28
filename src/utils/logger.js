/**
 * Simple logging utility.
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

class Logger {
  constructor(context = 'bridge') {
    this.context = context;
    this.logLevel = process.env.LOG_LEVEL || 'INFO';
  }

  _shouldLog(level) {
    const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
    return levels.indexOf(level) <= levels.indexOf(this.logLevel);
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] [${this.context}] ${message}${metaStr}`;
  }

  error(message, error = null) {
    if (!this._shouldLog('ERROR')) return;

    const meta = {};
    if (error) {
      meta.error = error.message;
      meta.stack = error.stack;
      if (error.code) meta.code = error.code;
      if (error.statusCode) meta.statusCode = error.statusCode;
    }

    console.error(this._formatMessage('ERROR', message, meta));
  }

  warn(message, meta = {}) {
    if (!this._shouldLog('WARN')) return;
    console.warn(this._formatMessage('WARN', message, meta));
  }

  info(message, meta = {}) {
    if (!this._shouldLog('INFO')) return;
    console.log(this._formatMessage('INFO', message, meta));
  }

  debug(message, meta = {}) {
    if (!this._shouldLog('DEBUG')) return;
    console.log(this._formatMessage('DEBUG', message, meta));
  }
}

export function createLogger(context) {
  return new Logger(context);
}

export default Logger;
