'use strict';
/**
 * modules/ddi/dhcplog.js — SMB/UNC (or local) Windows DHCP audit-log reader, ported from
 * DDIVault's collector/dhcpReader.js. Parses the CSV DhcpSrvLog-<Day>.log files into raw
 * event rows and ships them to the server (which does the DB writes + alerting).
 *
 * The one adaptation from the source: the log base path is taken PER SERVER from the
 * ddi_config (`server.dhcp_log_path`, a UNC share like \\\\SRV\\DHCPLogs or a local dir),
 * instead of the collector's process-wide DHCP_LOG_UNC / DHCP_LOG_LOCAL env vars. The
 * parseLine / EVENT_MAP / day-rotation logic is otherwise byte-for-byte the source.
 */
const fs = require('fs');
const path = require('path');

// Map event IDs to human labels and severity (verbatim from dhcpReader.js).
const EVENT_MAP = {
  10: { type: 'Assign', severity: 'info' },
  11: { type: 'Renew', severity: 'info' },
  12: { type: 'Release', severity: 'info' },
  13: { type: 'DNSUpdate', severity: 'info' },
  14: { type: 'DNSUpdate', severity: 'info' },
  15: { type: 'NACK', severity: 'warning' },
  16: { type: 'DNSDelete', severity: 'info' },
  20: { type: 'Expired', severity: 'info' },
  30: { type: 'DNSFailed', severity: 'warning' },
  34: { type: 'Conflict', severity: 'critical' },
  1013: { type: 'ScopeActive', severity: 'info' },
  1014: { type: 'ScopeInactive', severity: 'warning' },
  1016: { type: 'ScopeWarning', severity: 'warning' },
  1020: { type: 'ScopeFull', severity: 'critical' },
  2019: { type: 'RogueDHCP', severity: 'critical' },
};

// Windows DHCP logs rotate daily: DhcpSrvLog-Mon.log ... DhcpSrvLog-Sun.log.
function dayFileName(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `DhcpSrvLog-${days[date.getDay()]}.log`;
}

// Build the log path for a given date under a base path (UNC share or local dir).
function logFilePath(basePath, date) {
  const fileName = dayFileName(date);
  const base = (basePath || '').trim();
  if (!base) return path.join('C:\\Windows\\System32\\dhcp', fileName); // running ON the server
  if (base.startsWith('\\\\')) return `${base.replace(/\\+$/, '')}\\${fileName}`; // UNC
  return path.join(base, fileName);
}

// Parse a single CSV line (verbatim column mapping from the source).
function parseLine(line) {
  if (!line || line.startsWith('ID') || line.startsWith('Microsoft') ||
      line.startsWith('QResult') || line.trim() === '') {
    return null;
  }
  const parts = line.split(',');
  if (parts.length < 7) return null;

  const eventId = parseInt(parts[0], 10);
  if (isNaN(eventId)) return null;

  const dateStr = (parts[1] || '').trim();
  const timeStr = (parts[2] || '').trim();
  const desc = (parts[3] || '').trim();
  const ip = (parts[4] || '').trim() || null;
  const host = (parts[5] || '').trim() || null;
  const mac = (parts[6] || '').trim() || null;

  let eventTime = null;
  try {
    const [m, d, y] = dateStr.split('/');
    const fullYear = parseInt(y, 10) < 100 ? `20${y}` : y;
    eventTime = new Date(`${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${timeStr}`);
    if (isNaN(eventTime.getTime())) eventTime = null;
  } catch (_e) {
    eventTime = null;
  }

  const meta = EVENT_MAP[eventId] || { type: 'Unknown', severity: 'info' };
  return {
    event_id: eventId,
    event_type: meta.type,
    severity: meta.severity,
    ip_address: ip || null,
    hostname: host || null,
    mac_address: mac || null,
    description: desc || null,
    event_time: eventTime ? eventTime.toISOString() : null,
    raw_line: line,
  };
}

// Read + parse one day's log file under basePath. Missing file → [] (a scope may be idle).
function readDhcpLog(basePath, date) {
  const filePath = logFilePath(basePath, date || new Date());
  let content;
  try {
    content = fs.readFileSync(filePath, { encoding: 'utf8' });
  } catch (_err) {
    return [];
  }
  const events = [];
  for (const line of content.split('\n')) {
    const parsed = parseLine(line.trim());
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Read today's + yesterday's logs (spans the midnight rollover so no events are missed),
 * optionally filtered to events strictly AFTER `since` (an ISO string) for incremental
 * polling. Returns the raw parsed rows to ship as the `dhcp_events` kind.
 */
function readEvents(basePath, since) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const all = [...readDhcpLog(basePath, yesterday), ...readDhcpLog(basePath, today)];
  if (!since) return all;
  const cut = new Date(since);
  if (isNaN(cut.getTime())) return all;
  return all.filter((e) => e.event_time && new Date(e.event_time) > cut);
}

module.exports = { readEvents, readDhcpLog, parseLine, logFilePath, dayFileName, EVENT_MAP };
