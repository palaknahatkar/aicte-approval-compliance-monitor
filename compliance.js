const express = require('express');
const { notifications } = require('./scheduler');
const { logAudit } = require('./audit');
const { applications } = require('./data');

const router = express.Router();
const DAY = 86400000;
const regions = ['Central', 'Eastern', 'Northern', 'Southern', 'Western', 'South Western'];

// Rules (baad mein APH ke hisaab se badal lena)
const ALERT_BEFORE_DAYS = [30, 15, 7];
const ESCALATION = [
  { afterDaysOverdue: 0, level: 1, to: 'REGIONAL_OFFICER' },
  { afterDaysOverdue: 7, level: 2, to: 'BUREAU_OFFICER' },
  { afterDaysOverdue: 15, level: 3, to: 'COMMITTEE_HEAD' }
];

function daysLeftOf(d) { return Math.ceil((new Date(d) - Date.now()) / DAY); }
function healthOf(n) { return n < 0 ? 'RED' : n <= 7 ? 'AMBER' : 'GREEN'; }
function randDays(min, max) { return Math.floor(Math.random() * (max - min)) + min; }

// ---------- Dummy data ----------
const undertakings = [];
for (let i = 1; i <= 30; i++) {
  undertakings.push({
    id: i,
    institution: 'Demo Institute ' + i,
    region: regions[i % regions.length],
    condition: 'Fire NOC submit karna',
    dueDate: new Date(Date.now() + randDays(-25, 40) * DAY).toISOString(),
    status: 'PENDING',          // PENDING -> SUBMITTED -> VERIFIED
    evidence: null,
    verifiedBy: null
  });
}

const documents = [];
for (let i = 1; i <= 40; i++) {
  documents.push({
    id: i,
    institution: 'Demo Institute ' + i,
    region: regions[i % regions.length],
    docType: 'LEASE',
    expiryDate: new Date(Date.now() + randDays(-20, 120) * DAY).toISOString(),
    status: 'VALID',            // VALID -> RENEWAL_SUBMITTED -> RENEWED
    verifiedBy: null
  });
}

const evcScheduled = {};   // applicationId -> true/false
const evcDates = {};       // applicationId -> 'YYYY-MM-DD'

// ---------- Alert helper ----------
function addAlert(kind, item, type, level, to, message) {
  const key = kind + '-' + item.id + '-' + type + '-' + level;
  if (notifications.some(n => n.key === key)) return;
  notifications.push({
    key, entity: kind, entityId: item.id,
    institution: item.institution, region: item.region,
    type, level, to, message, createdAt: new Date().toISOString()
  });
  logAudit(kind, item.id, 'ALERT_' + type + '_L' + level, 'SYSTEM', message);
}

function checkItem(kind, item, label, upcomingType, overdueType) {
  const left = daysLeftOf(item.dueDate || item.expiryDate);

  if (left >= 0) {
    const t = ALERT_BEFORE_DAYS.filter(x => left <= x).sort((a, b) => a - b)[0];
    if (t) {
      addAlert(kind, item, upcomingType, 0, 'INSTITUTION',
        item.institution + ': ' + label + ' ' + left + ' din mein due hai');
    }
  } else {
    const overdue = -left;
    ESCALATION.forEach(e => {
      if (overdue >= e.afterDaysOverdue) {
        addAlert(kind, item, overdueType, e.level, e.to,
          item.institution + ': ' + label + ' ' + overdue + ' din se overdue, escalated to ' + e.to);
      }
    });
  }
}

function runComplianceCheck() {
  undertakings.forEach(u => {
    if (u.status === 'PENDING') checkItem('undertaking', u, 'Undertaking', 'UNDERTAKING_DUE', 'UNDERTAKING_OVERDUE');
  });
  documents.forEach(d => {
    if (d.status === 'VALID') checkItem('document', d, d.docType + ' expiry', 'DOC_EXPIRY_SOON', 'DOC_EXPIRED');
  });
  applications.forEach(a => {
    if (a.currentStage !== 'EVC' || a.status !== 'IN_PROGRESS') return;
    if (evcScheduled[a.id] === undefined) evcScheduled[a.id] = false;
    if (!evcScheduled[a.id]) {
      checkItem('evc', { id: a.id, institution: a.institution, region: a.region, dueDate: a.dueDate },
        'EVC scheduling', 'EVC_DUE', 'EVC_OVERDUE');
    }
  });
}

// ---------- APIs ----------
router.get('/undertakings', (req, res) => {
  res.json(undertakings.map(u => {
    const daysLeft = daysLeftOf(u.dueDate);
    return { ...u, daysLeft, health: u.status === 'VERIFIED' ? 'DONE' : healthOf(daysLeft) };
  }));
});

router.get('/documents', (req, res) => {
  res.json(documents.map(d => {
    const daysLeft = daysLeftOf(d.expiryDate);
    return { ...d, daysLeft, health: d.status === 'RENEWED' ? 'DONE' : healthOf(daysLeft) };
  }));
});

router.get('/evc', (req, res) => {
  const list = applications
    .filter(a => a.currentStage === 'EVC' && a.status === 'IN_PROGRESS')
    .map(a => {
      if (evcScheduled[a.id] === undefined) evcScheduled[a.id] = false;
      const daysLeft = daysLeftOf(a.dueDate);
      return {
        applicationId: a.id, institution: a.institution, region: a.region,
        scheduled: evcScheduled[a.id], evcDate: evcDates[a.id] || null,
        dueDate: a.dueDate, daysLeft, health: healthOf(daysLeft)
      };
    });
  res.json(list);
});

// EVC ki date schedule karna
router.post('/evc/:id/schedule', (req, res) => {
  const a = applications.find(x => x.id === Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Application nahi mili' });
  const date = req.body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'EVC ki date YYYY-MM-DD format mein chahiye' });
  }
  evcScheduled[a.id] = true;
  evcDates[a.id] = date;
  logAudit('evc', a.id, 'EVC_SCHEDULED for ' + date, req.body.actor || 'officer');
  res.json({ ok: true, applicationId: a.id, date });
});

router.get('/compliance-summary', (req, res) => {
  const u = undertakings.map(x => ({ ...x, left: daysLeftOf(x.dueDate) }));
  const d = documents.map(x => ({ ...x, left: daysLeftOf(x.expiryDate) }));
  res.json({
    undertakings: {
      total: u.length,
      overdue: u.filter(x => x.status === 'PENDING' && x.left < 0).length,
      dueSoon: u.filter(x => x.status === 'PENDING' && x.left >= 0 && x.left <= 30).length,
      verified: u.filter(x => x.status === 'VERIFIED').length
    },
    documents: {
      total: d.length,
      expired: d.filter(x => x.status === 'VALID' && x.left < 0).length,
      expiringIn30Days: d.filter(x => x.status === 'VALID' && x.left >= 0 && x.left <= 30).length,
      renewed: d.filter(x => x.status === 'RENEWED').length
    }
  });
});

// Institution evidence submit karti hai
router.post('/undertakings/:id/submit', (req, res) => {
  const u = undertakings.find(x => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Nahi mila' });
  u.status = 'SUBMITTED';
  u.evidence = req.body.evidence || 'evidence.pdf';
  logAudit('undertaking', u.id, 'EVIDENCE_SUBMITTED', u.institution);
  res.json(u);
});

// Officer verify karta hai (human oversight)
router.post('/undertakings/:id/verify', (req, res) => {
  const u = undertakings.find(x => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Nahi mila' });
  u.status = 'VERIFIED';
  u.verifiedBy = req.body.actor || 'officer';
  logAudit('undertaking', u.id, 'VERIFIED', u.verifiedBy);
  res.json(u);
});

router.post('/documents/:id/renew', (req, res) => {
  const d = documents.find(x => x.id === Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Nahi mila' });
  d.status = 'RENEWAL_SUBMITTED';
  d.newExpiryDate = req.body.newExpiry || new Date(Date.now() + 365 * DAY).toISOString();
  logAudit('document', d.id, 'RENEWAL_SUBMITTED', d.institution);
  res.json(d);
});

router.post('/documents/:id/verify', (req, res) => {
  const d = documents.find(x => x.id === Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Nahi mila' });
  d.status = 'RENEWED';
  d.expiryDate = d.newExpiryDate || d.expiryDate;
  d.verifiedBy = req.body.actor || 'officer';
  logAudit('document', d.id, 'RENEWAL_VERIFIED', d.verifiedBy);
  res.json(d);
});

runComplianceCheck();
setInterval(runComplianceCheck, 60 * 1000);

router.data = { undertakings, documents, evcScheduled, evcDates };
module.exports = router;