import app from './app';
import { env } from './config/env';
import { startCronJobs } from './jobs/closeLots.job';

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`SurplusBid API listening on port ${env.port}`);
  startCronJobs();
});
