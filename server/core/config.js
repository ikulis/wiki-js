const _ = require('lodash')
const chalk = require('chalk')
const cfgHelper = require('../helpers/config')
const fs = require('fs')
const path = require('path')
const url = require('url')
const yaml = require('js-yaml')

/* global WIKI */

function applyDatabaseUrlEnv(appconfig, DATABASE_URL) {
  const dbUrl = new url.URL(DATABASE_URL)

  // Extract connection parameters based on database type
  switch (dbUrl.protocol) {
    case 'postgres:':
    case 'postgresql:':
      appconfig.db.type = 'postgres'
      break
    case 'mysql:':
      appconfig.db.type = 'mysql'
      break
    case 'mariadb:':
      appconfig.db.type = 'mariadb'
      break
    case 'mssql:':
    case 'sqlserver:':
      appconfig.db.type = 'mssql'
      break
    case 'sqlite:':
      appconfig.db.type = 'sqlite'
      break
    default:
      console.warn(chalk.yellow(`  Unknown database protocol: ${dbUrl.protocol}. Skipping DATABASE_URL apply.`))
      return false;
  }

  // SQLite uses a file path instead of host/port/user/pass
  if (appconfig.db.type === 'sqlite') {
    if (dbUrl.pathname) {
      appconfig.db.storage = dbUrl.pathname
    }
  } else {
    // For client-server databases (postgres, mysql, mariadb, mssql)
    if (dbUrl.hostname) {
      appconfig.db.host = dbUrl.hostname
    }

    if (dbUrl.port) {
      appconfig.db.port = parseInt(dbUrl.port, 10)
    }

    if (dbUrl.username) {
      appconfig.db.user = dbUrl.username
    }

    if (dbUrl.password) {
      appconfig.db.pass = dbUrl.password
    }

    if (dbUrl.pathname && dbUrl.pathname.length > 1) {
      appconfig.db.db = dbUrl.pathname.substring(1) // Remove leading slash
    }
  }

  // Parse SSL mode from query parameters
  const searchParams = new url.URLSearchParams(dbUrl.search)
  if (searchParams.has('sslmode')) {
    const sslMode = searchParams.get('sslmode')
    // SSL is enabled for all modes except 'disable'
    appconfig.db.ssl = sslMode !== 'disable'
    console.info(chalk.blue(`  SSL mode: ${sslMode} (ssl: ${appconfig.db.ssl})`))
  }

  return true;
}

module.exports = {
  /**
   * Load root config from disk
   */
  init() {
    let confPaths = {
      config: path.join(WIKI.ROOTPATH, 'config.yml'),
      data: path.join(WIKI.SERVERPATH, 'app/data.yml'),
      dataRegex: path.join(WIKI.SERVERPATH, 'app/regex.js')
    }

    if (process.env.dockerdev) {
      confPaths.config = path.join(WIKI.ROOTPATH, `dev/containers/config.yml`)
    }

    if (process.env.CONFIG_FILE) {
      confPaths.config = path.resolve(WIKI.ROOTPATH, process.env.CONFIG_FILE)
    }

    process.stdout.write(chalk.blue(`Loading configuration from ${confPaths.config}... `))

    let appconfig = {}
    let appdata = {}

    try {
      appconfig = yaml.safeLoad(
        cfgHelper.parseConfigValue(
          fs.readFileSync(confPaths.config, 'utf8')
        )
      )
      appdata = yaml.safeLoad(fs.readFileSync(confPaths.data, 'utf8'))
      appdata.regex = require(confPaths.dataRegex)
      console.info(chalk.green.bold(`OK`))
    } catch (err) {
      console.error(chalk.red.bold(`FAILED`))
      console.error(err.message)

      console.error(chalk.red.bold(`>>> Unable to read configuration file! Did you create the config.yml file?`))
      process.exit(1)
    }

    // Merge with defaults

    appconfig = _.defaultsDeep(appconfig, appdata.defaults.config)

    if (appconfig.port < 1 || process.env.HEROKU) {
      appconfig.port = process.env.PORT || 80
    }

    const packageInfo = require(path.join(WIKI.ROOTPATH, 'package.json'))

    // Parse DATABASE_URL environment variable
    if (process.env.DATABASE_URL) {
      console.info(chalk.blue(`DATABASE_URL is defined. Parsing connection string...`))
      try {
        const applied = applyDatabaseUrlEnv(appconfig, process.env.DATABASE_URL);
        if(applied){
          console.info(chalk.green.bold(`Database connection parsed successfully`))
        } else {
          console.info(chalk.yellow.bold(`DATABASE_URL not applied`))
        }
      } catch (err) {
        console.error(chalk.red.bold(`>>> Failed to parse DATABASE_URL environment variable!`))
        console.error(err.message)
        process.exit(1)
      }
    }

    // Load DB Password from Docker Secret File
    if (process.env.DB_PASS_FILE) {
      console.info(chalk.blue(`DB_PASS_FILE is defined. Will use secret from file.`))
      try {
        appconfig.db.pass = fs.readFileSync(process.env.DB_PASS_FILE, 'utf8').trim()
      } catch (err) {
        console.error(chalk.red.bold(`>>> Failed to read Docker Secret File using path defined in DB_PASS_FILE env variable!`))
        console.error(err.message)
        process.exit(1)
      }
    }

    WIKI.config = appconfig
    WIKI.data = appdata
    WIKI.version = packageInfo.version
    WIKI.releaseDate = packageInfo.releaseDate
    WIKI.devMode = (packageInfo.dev === true)
  },

  /**
   * Load config from DB
   */
  async loadFromDb() {
    let conf = await WIKI.models.settings.getConfig()
    if (conf) {
      WIKI.config = _.defaultsDeep(conf, WIKI.config)
    } else {
      WIKI.logger.warn('DB Configuration is empty or incomplete. Switching to Setup mode...')
      WIKI.config.setup = true
    }
  },
  /**
   * Save config to DB
   *
   * @param {Array} keys Array of keys to save
   * @returns Promise
   */
  async saveToDb(keys, propagate = true) {
    try {
      for (let key of keys) {
        let value = _.get(WIKI.config, key, null)
        if (!_.isPlainObject(value)) {
          value = { v: value }
        }
        let affectedRows = await WIKI.models.settings.query().patch({ value }).where('key', key)
        if (affectedRows === 0 && value) {
          await WIKI.models.settings.query().insert({ key, value })
        }
      }
      if (propagate) {
        WIKI.events.outbound.emit('reloadConfig')
      }
    } catch (err) {
      WIKI.logger.error(`Failed to save configuration to DB: ${err.message}`)
      return false
    }

    return true
  },
  /**
   * Apply Dev Flags
   */
  async applyFlags() {
    WIKI.models.knex.client.config.debug = WIKI.config.flags.sqllog
  },

  /**
   * Subscribe to HA propagation events
   */
  subscribeToEvents() {
    WIKI.events.inbound.on('reloadConfig', async () => {
      await WIKI.configSvc.loadFromDb()
      await WIKI.configSvc.applyFlags()
    })
  }
}
