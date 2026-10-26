const rules = require('./rules.json');

const regions = ['Central', 'Eastern', 'Northern', 'Southern', 'Western', 'South Western'];
const workflowNames = Object.keys(rules.workflows);
const DAY = 86400000;

const applications = [];

for (let i = 1; i <= 60; i++) {
  const workflow = workflowNames[i % workflowNames.length];
  const stage = rules.workflows[workflow][0];
  const started = new Date(Date.now() - Math.floor(Math.random() * 40) * DAY);
  const due = new Date(started.getTime() + rules.stageSLA_days[stage] * DAY);

  applications.push({
    id: i,
    institution: 'Demo Institute ' + i,
    region: regions[i % regions.length],
    workflow: workflow,
    currentStage: stage,
    status: 'IN_PROGRESS',
    stageStartedAt: started.toISOString(),
    dueDate: due.toISOString()
  });
}

module.exports = { applications };