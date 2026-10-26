const express = require('express');
const router = express.Router();
const { applications } = require('./data');
const compliance = require('./compliance');

const DAY = 86400000;
const left = d => Math.ceil((new Date(d) - Date.now()) / DAY);
const day = d => (d ? String(d).slice(0, 10) : '');

function toCSV(rows) {
  if (!rows.length) return 'Koi data nahi';
  const cols = Object.keys(rows[0]);
  const esc = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

function send(res, name, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=' + name + '.csv');
  res.send(toCSV(rows));
}

const inRegion = (list, q) => (q.region && q.region !== 'ALL') ? list.filter(x => x.region === q.region) : list;

// 1. Application pendency
router.get('/pendency.csv', (req, res) => {
  const rows = inRegion(applications, req.query)
    .filter(a => a.status === 'IN_PROGRESS')
    .map(a => ({
      application_id: a.id, institution: a.institution, region: a.region,
      workflow: a.workflow, current_stage: a.currentStage,
      stage_started: day(a.stageStartedAt), due_date: day(a.dueDate),
      days_left_negative_means_overdue: left(a.dueDate)
    }));
  send(res, 'application_pendency', rows);
});

// 2. EVC status
router.get('/evc.csv', (req, res) => {
  const { evcScheduled, evcDates } = compliance.data;
  const rows = inRegion(applications, req.query)
    .filter(a => a.currentStage === 'EVC' && a.status === 'IN_PROGRESS')
    .map(a => ({
      application_id: a.id, institution: a.institution, region: a.region,
      evc_scheduled: evcScheduled[a.id] ? 'Yes' : 'No',
      evc_date: evcDates[a.id] || '', stage_due_date: day(a.dueDate)
    }));
  send(res, 'evc_status', rows);
});

// 3. Undertaking compliance
router.get('/undertakings.csv', (req, res) => {
  const rows = inRegion(compliance.data.undertakings, req.query).map(u => ({
    id: u.id, institution: u.institution, region: u.region, condition: u.condition,
    due_date: day(u.dueDate), status: u.status, verified_by: u.verifiedBy || ''
  }));
  send(res, 'undertaking_compliance', rows);
});

// 4. Document validity
router.get('/documents.csv', (req, res) => {
  const rows = inRegion(compliance.data.documents, req.query).map(d => ({
    id: d.id, institution: d.institution, region: d.region, document: d.docType,
    expiry_date: day(d.expiryDate), status: d.status, verified_by: d.verifiedBy || ''
  }));
  send(res, 'document_validity', rows);
});

// 5. Saare overdue cases ek jagah
router.get('/overdue.csv', (req, res) => {
  const rows = [];
  inRegion(applications, req.query).forEach(a => {
    if (a.status === 'IN_PROGRESS' && left(a.dueDate) < 0)
      rows.push({ type: 'Application', id: a.id, institution: a.institution, region: a.region,
        item: a.currentStage, due_date: day(a.dueDate), days_overdue: -left(a.dueDate) });
  });
  inRegion(compliance.data.undertakings, req.query).forEach(u => {
    if (u.status === 'PENDING' && left(u.dueDate) < 0)
      rows.push({ type: 'Undertaking', id: u.id, institution: u.institution, region: u.region,
        item: u.condition, due_date: day(u.dueDate), days_overdue: -left(u.dueDate) });
  });
  inRegion(compliance.data.documents, req.query).forEach(d => {
    if (d.status === 'VALID' && left(d.expiryDate) < 0)
      rows.push({ type: 'Document expired', id: d.id, institution: d.institution, region: d.region,
        item: d.docType, due_date: day(d.expiryDate), days_overdue: -left(d.expiryDate) });
  });
  send(res, 'overdue_cases', rows);
});

// 6. Region-wise performance
router.get('/region-performance.csv', (req, res) => {
  const { undertakings, documents } = compliance.data;
  const regions = [...new Set(applications.map(a => a.region))];
  const rows = regions.map(r => {
    const apps = applications.filter(a => a.region === r);
    const inProg = apps.filter(a => a.status === 'IN_PROGRESS');
    return {
      region: r,
      total_applications: apps.length,
      in_progress: inProg.length,
      overdue: inProg.filter(a => left(a.dueDate) < 0).length,
      returned_for_deficiency: apps.filter(a => a.status === 'RETURNED').length,
      ready_for_decision: apps.filter(a => a.status === 'READY_FOR_DECISION').length,
      overdue_undertakings: undertakings.filter(u => u.region === r && u.status === 'PENDING' && left(u.dueDate) < 0).length,
      expired_documents: documents.filter(d => d.region === r && d.status === 'VALID' && left(d.expiryDate) < 0).length
    };
  });
  send(res, 'region_performance', rows);
});

module.exports = router;