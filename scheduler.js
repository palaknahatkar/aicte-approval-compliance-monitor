const rules = require('./rules.json');
const { logAudit } = require('./audit');

const DAY = 86400000;
const notifications = [];

function addNotification(a, type, level, to, message) {
  // Same alert dobara na bane, isliye key check
  const key = a.id + '-' + a.currentStage + '-' + type + '-' + level;
  if (notifications.some(n => n.key === key)) return;

  notifications.push({
    key,
    applicationId: a.id,
    institution: a.institution,
    region: a.region,
    type,
    level,
    to,
    message,
    createdAt: new Date().toISOString()
  });
  logAudit('notification', a.id, 'ALERT_' + type + '_L' + level, 'SYSTEM', message);
}

function runCheck(applications) {
  applications.forEach(a => {
    if (a.status !== 'IN_PROGRESS') return;

    const daysLeft = Math.ceil((new Date(a.dueDate) - Date.now()) / DAY);

    // Deadline paas aa rahi hai
    if (daysLeft >= 0 && daysLeft <= rules.amberBeforeDays) {
      addNotification(a, 'UPCOMING', 0, 'REGIONAL_OFFICER',
        a.institution + ': ' + a.currentStage + ' ki deadline ' + daysLeft + ' din mein hai');
    }

    // Deadline nikal gayi, escalation ladder
    if (daysLeft < 0) {
      const overdueDays = -daysLeft;
      rules.escalation.forEach(e => {
        if (overdueDays >= e.afterDaysOverdue) {
          addNotification(a, 'OVERDUE', e.level, e.to,
            a.institution + ': ' + a.currentStage + ' ' + overdueDays +
            ' din se overdue hai, escalated to ' + e.to);
        }
      });
    }
  });
  return notifications.length;
}

module.exports = { notifications, runCheck };