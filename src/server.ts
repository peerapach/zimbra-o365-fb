import { isAbsolute } from 'node:path';
import { startConfiguredGateway } from './runtime/assemble.js';
import { installShutdownHandler } from './observability/health.js';

try {
  const path = process.env.FREEBUSY_CONFIG;
  if (!path || !isAbsolute(path) || process.env.FREEBUSY_INGRESS_APPROVED !== 'public+private') throw new Error();
  const gateway = await startConfiguredGateway(path, { ingressApproved: true });
  installShutdownHandler(gateway.shutdown);
} catch {
  process.stderr.write('Gateway runtime unavailable\n');
  process.exitCode = 1;
}
