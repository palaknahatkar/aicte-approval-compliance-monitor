const express = require('express');
const cors = require('cors');
const path = require('path');
const rules = require('./rules.json');
const { applications } = require('./data');
const { auditLog, logAudit } = require('./audit');
const { notifications, runCheck } = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DAY = 86400000;

// Health: PAUSED (returned), DONE (decision ke liye ready), RED, AMBER, GREEN
function withHealth(a) {
  const daysLeft = Math.ceil((new Date(a.dueDate) - Date.now()) / DAY);
  let health = 'GREEN';
  if (a.status === 'RETURNED') health = 'PAUSED';
  else if (a.status === 'READY_FOR_DECISION') health = 'DONE';
  else if (daysLeft < 0) health = 'RED';
  else if (daysLeft <= rules.amberBeforeDays) health = 'AMBER';
  return { ...a, daysLeft, health };
}

function findApp(req, res) {
  const a = applications.find(x => x.id === Number(req.params.id));
  if (!a) res.status(404).json({ error: 'Application nahi mili' });
  return a;
}

app.get('/api/health', (req, res) => {
  res.json({ message: 'Server chal raha hai!' });
});

app.get('/api/applications', (req, res) => {
  res.json(applications.map(withHealth));
});

app.get('/api/summary', (req, res) => {
  const list = applications.map(withHealth);
  const byRegion = {};
  const byStage = {};
  list.forEach(a => {
    byRegion[a.region] = byRegion[a.region] || { total: 0, overdue: 0 };
    byRegion[a.region].total++;
    if (a.health === 'RED') byRegion[a.region].overdue++;
    byStage[a.currentStage] = (byStage[a.currentStage] || 0) + 1;
  });
  res.json({
    total: list.length,
    overdue: list.filter(a => a.health === 'RED').length,
    amber: list.filter(a => a.health === 'AMBER').length,
    green: list.filter(a => a.health === 'GREEN').length,
    returned: list.filter(a => a.health === 'PAUSED').length,
    byRegion, byStage
  });
});

// Agle stage par bhejna (auto-routing)
app.post('/api/applications/:id/advance', (req, res) => {
  const a = findApp(req, res);
  if (!a) return;
  if (a.status !== 'IN_PROGRESS') {
    return res.status(400).json({ error: 'Application abhi IN_PROGRESS nahi hai' });
  }

  const stages = rules.workflows[a.workflow];
  const i = stages.indexOf(a.currentStage);
  const actor = req.body.actor || 'officer';

  if (i === stages.length - 1) {
    a.status = 'READY_FOR_DECISION';
    logAudit('application', a.id, 'ALL_STAGES_DONE', actor,
      'Final decision competent authority lega');
    return res.json(withHealth(a));
  }

  const next = stages[i + 1];
  const now = new Date();
  logAudit('application', a.id, 'MOVED ' + a.currentStage + ' -> ' + next, actor);
  a.currentStage = next;
  a.stageStartedAt = now.toISOString();
  a.dueDate = new Date(now.getTime() + rules.stageSLA_days[next] * DAY).toISOString();
  res.json(withHealth(a));
});

// Deficiency / clarification ke liye return (reason zaroori)
app.post('/api/applications/:id/revert', (req, res) => {
  const a = findApp(req, res);
  if (!a) return;
  if (a.status !== 'IN_PROGRESS') {
    return res.status(400).json({ error: 'Sirf IN_PROGRESS application return ho sakti hai' });
  }
  const reason = (req.body.reason || '').trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: 'Return ka reason likhna zaroori hai (kam se kam 5 akshar)' });
  }
  const actor = req.body.actor || 'officer';

  a.status = 'RETURNED';
  a.returnReason = reason;
  a.returnedAt = new Date().toISOString();
  a.returnCount = (a.returnCount || 0) + 1;

  logAudit('application', a.id, 'RETURNED at ' + a.currentStage, actor, reason);
  notifications.push({
    key: 'ret-' + a.id + '-' + a.returnCount,
    entity: 'application', entityId: a.id, applicationId: a.id,
    institution: a.institution, region: a.region,
    type: 'RETURNED', level: 0, to: 'INSTITUTION',
    message: a.institution + ': application return hui (' + a.currentStage + '). Reason: ' + reason,
    createdAt: new Date().toISOString()
  });
  res.json(withHealth(a));
});

// Institution deficiency theek karke dobara bhejti hai
app.post('/api/applications/:id/resubmit', (req, res) => {
  const a = findApp(req, res);
  if (!a) return;
  if (a.status !== 'RETURNED') {
    return res.status(400).json({ error: 'Application returned state mein nahi hai' });
  }
  const now = new Date();
  a.status = 'IN_PROGRESS';
  a.returnReason = null;
  a.stageStartedAt = now.toISOString();
  a.dueDate = new Date(now.getTime() + rules.stageSLA_days[a.currentStage] * DAY).toISOString();
  logAudit('application', a.id, 'RESUBMITTED at ' + a.currentStage, req.body.actor || 'Institution');
  res.json(withHealth(a));
});

app.get('/api/audit', (req, res) => res.json(auditLog));
app.get('/api/notifications', (req, res) => res.json(notifications));

app.post('/api/run-check', (req, res) => {
  res.json({ totalNotifications: runCheck(applications) });
});

// Automatic scheduler: har 1 minute mein check
runCheck(applications);
setInterval(() => runCheck(applications), 60 * 1000);

app.use('/api', require('./compliance'));
app.use('/api/reports', require('./reports'));

app.listen(5050, () => console.log('NAYA SERVER ready on port 5050'));