const crypto = require('crypto');

const auditLog = [];

function logAudit(entity, entityId, action, actor, reason = '') {
  const prev = auditLog.length ? auditLog[auditLog.length - 1].hash : 'GENESIS';
  const createdAt = new Date().toISOString();
  const hash = crypto
    .createHash('sha256')
    .update(prev + entity + entityId + action + actor + reason + createdAt)
    .digest('hex');
  auditLog.push({ entity, entityId, action, actor, reason, prev, hash, createdAt });
}

module.exports = { auditLog, logAudit };