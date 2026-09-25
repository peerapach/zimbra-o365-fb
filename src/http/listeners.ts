import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { ValidatedConfig } from '../config/validate.js';
import { collectRawXml, InputError } from './raw-xml.js';

type Surface = 'm365-inbound' | 'zimbra-inbound' | 'management';
export type SurfaceListener = FastifyInstance & { readonly surface: Surface };

function rejectInput(request: FastifyRequest, reply: FastifyReply, status: number) {
  request.raw.pause();
  reply.raw.once('finish', () => request.raw.destroy());
  return reply.header('connection', 'close').code(status).send({ error: 'Request rejected' });
}

function createListener(surface: Surface, limits: ValidatedConfig['limits']): SurfaceListener {
  const app = Object.assign(Fastify({
    logger: false, trustProxy: false, exposeHeadRoutes: false,
    bodyLimit: limits.maxRequestBytes,
    requestTimeout: limits.bodyReceiveTimeoutMs,
    connectionTimeout: limits.bodyReceiveTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    http: {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.bodyReceiveTimeoutMs,
      requestTimeout: limits.bodyReceiveTimeoutMs,
      connectionsCheckingInterval: 1000,
      keepAliveTimeoutBuffer: 0,
    },
  }), { surface });
  Object.defineProperty(app, 'surface', { writable: false, configurable: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (request: FastifyRequest, payload: IncomingMessage) => collectRawXml(payload, request.headers['content-length'], limits));
  app.setErrorHandler((error, request, reply) => rejectInput(request, reply, error instanceof InputError ? error.statusCode : 500));
  app.setNotFoundHandler((request, reply) => rejectInput(request, reply, 404));
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url;
    const applicationRoute = surface !== 'management' && request.method === 'POST'
      && (route === '/EWS/Exchange.asmx' || (surface === 'm365-inbound' && route === '/autodiscover/autodiscover.xml'));
    if (!applicationRoute) {
      if (surface === 'management' && request.method === 'GET' && ['/healthz', '/readyz', '/metrics'].includes(route ?? '')) return;
      return rejectInput(request, reply, 404);
    }
    // Deliberately narrow parameter profile; bytes are not decoded here.
    const mediaType = /^(text\/xml|application\/xml)(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i
      .exec(request.headers['content-type']?.trim() ?? '')?.[1]?.toLowerCase();
    if (!mediaType || (route === '/EWS/Exchange.asmx' && mediaType !== 'text/xml')
      || (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')) {
      return rejectInput(request, reply, 415);
    }
  });
  if (surface === 'management') {
    app.get('/healthz', async () => ({ status: 'ok' }));
  } else {
    const unavailable = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(503).send({ error: 'Service unavailable' });
    app.post('/EWS/Exchange.asmx', unavailable);
    if (surface === 'm365-inbound') app.post('/autodiscover/autodiscover.xml', unavailable);
  }
  return app;
}

export function createListeners(config: ValidatedConfig) {
  return Object.freeze({
    public: createListener('m365-inbound', config.limits),
    private: createListener('zimbra-inbound', config.limits),
    management: createListener('management', config.limits),
  });
}
