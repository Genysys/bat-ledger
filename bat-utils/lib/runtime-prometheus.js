const client = require('prom-client')
const _ = require('underscore')
const redis = require('redis')
const listenerPrefix = `listeners:prometheus:`
const listenerChannel = `${listenerPrefix}${process.env.SERVICE}`

module.exports = Prometheus

function Prometheus (config, runtime) {
  if (!(this instanceof Prometheus)) {
    return new Prometheus(config, runtime)
  }

  const { prometheus } = config
  if (!prometheus) return

  const { label: dyno } = prometheus
  this.config = prometheus
  this.register = new client.Registry()
  this.client = client
  this.runtime = runtime
  this.metrics = {}
  this.shared = {}
  this.listenerId = `${listenerPrefix}${dyno}`
  this.cache = redis.createClient(prometheus.redis)

  this.register.setDefaultLabels({ dyno })

  const timeout = 10000
  this.timeout = timeout
  setInterval(() => this.maintenance(), timeout)
  process.on('exit', () => {
    try {
      this.quit()
    } catch (e) {
      this.runtime.captureException(e)
    }
  })
  this.registerMetrics()
  this.registerMetrics = _.noop
}

Prometheus.prototype.maintenance = async function () {
  const { interval, timeout, client, register } = this
  this.interval = interval || client.collectDefaultMetrics({
    timeout,
    register
  })
  await this.publish()
}

Prometheus.prototype.duration = function (start) {
  const diff = process.hrtime(start)
  return Math.round((diff[0] * 1e9 + diff[1]) / 1000000)
}

Prometheus.prototype.quit = function () {
  const { interval, cache } = this
  clearInterval(interval)
  if (cache) {
    cache.quit()
  }
}

Prometheus.prototype.allMetrics = async function () {
  const { client, cache } = this
  const keys = await cache.keysAsync(`${listenerChannel}.*`)
  const all = await cache.mgetAsync(keys)
  const metrics = all.map(JSON.parse)
  return client.AggregatorRegistry.aggregate(metrics)
}

Prometheus.prototype.registerMetrics = function () {
  const { client, register } = this
  const log2Buckets = client.exponentialBuckets(2, 2, 15)

  new client.Summary({ // eslint-disable-line
    registers: [register],
    name: 'http_request_duration_milliseconds',
    help: 'request duration in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status']
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'http_request_buckets_milliseconds',
    help: 'request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'uphold_request_buckets_milliseconds',
    help: 'uphold request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeVerify_request_buckets_milliseconds',
    help: 'anonize verify duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status', 'erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeRegister_request_buckets_milliseconds',
    help: 'anonize register buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status', 'erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'viewRefresh_request_buckets_milliseconds',
    help: 'postgres view refresh buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status', 'erred'],
    buckets: log2Buckets
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'vote_counter',
    help: 'vote counter',
    labelNames: ['surveyorId', 'frozen', 'missing']
  })
}

Prometheus.prototype.plugin = function () {
  const plugin = {
    register: (server, o, done) => {
      server.route({
        method: 'GET',
        path: '/metrics',
        handler: async (req, reply) => {
          const registry = await this.allMetrics()
          const metrics = registry.metrics()
          reply(metrics).type('text/plain')
        }
      })

      server.ext('onRequest', (request, reply) => {
        request.prometheus = { start: process.hrtime() }
        reply.continue()
      })

      server.on('response', (response) => {
        const analysis = response._route._analysis
        const statusCode = response.response.statusCode
        let cardinality, method, params, path

        const duration = this.duration(response.prometheus.start)

        method = response.method.toLowerCase()
        params = _.clone(analysis.params)
        cardinality = params.length ? 'many' : 'one'
        path = analysis.fingerprint.split('/')
        for (let i = 0; i < path.length; i++) { if (path[i] === '?') path[i] = '{' + (params.shift() || '?') + '}' }
        path = path.join('/')

        const observables = {
          method,
          path,
          cardinality,
          status: statusCode || 0
        }
        this.metric('http_request_duration_milliseconds')
          .observe(observables, duration)

        this.metric('http_request_buckets_milliseconds')
          .observe(observables, duration)
      })

      this.maintenance()
      return done()
    }
  }

  plugin.register.attributes = {
    name: 'runtime-prometheus',
    version: '1.0.0'
  }

  return plugin
}

Prometheus.prototype.reset = async function (name) {
  return this.metric(name).reset()
}

Prometheus.prototype.increment = async function (name, labels = {}, delta = 1) {
  return this.metric(name).inc(labels, delta)
}

Prometheus.prototype.metric = function (name) {
  return this.register.getSingleMetric(name)
}

Prometheus.prototype.timedRequest = function (name, knownObs = {}) {
  const metric = this.metric(name)
  const start = process.hrtime()
  return (moreObs = {}) => {
    const duration = this.duration(start)
    const labels = Object.assign({}, knownObs, moreObs)
    metric.observe(labels, duration)
  }
}

Prometheus.prototype.publish = async function () {
  const { register, timeout, listenerId, cache } = this
  // x2 for buffer
  const timeoutSeconds = (timeout / 1000) * 2
  const data = register.getMetricsAsJSON()
  const json = JSON.stringify(data)
  await cache.setAsync(listenerId, json, 'EX', timeoutSeconds)
}
