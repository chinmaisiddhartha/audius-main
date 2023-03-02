import Umzug from 'umzug'
import path from 'path'
import { logger } from './logging'

const { sequelize } = require('./models')

export async function runMigrations() {
  const umzug = new Umzug({
    storage: 'sequelize',

    storageOptions: {
      sequelize: sequelize
    },

    migrations: {
      params: [sequelize.getQueryInterface(), sequelize.constructor],
      path: path.join(__dirname, '../sequelize/migrations')
    }
  })
  return umzug.up()
}

export async function clearDatabase() {
  // clear and recreate database schema, which cascades to all tables and rows in tables
  // for use in testing only - will delete all data in the database!!
  await sequelize.query('DROP SCHEMA IF EXISTS public CASCADE')
  await sequelize.query('CREATE SCHEMA public')
}

export async function clearRunningQueries() {
  logger.debug(`Clearing running db queries...`)
  try {
    await sequelize.query(`
    BEGIN;
        SELECT
            pg_cancel_backend(pid),
            pid,
            state,
            age(clock_timestamp(), query_start),
            substring(trim(regexp_replace(query, '\\s+', ' ', 'g')) from 1 for 200)
        FROM pg_stat_activity
        WHERE state != 'idle' AND query NOT ILIKE '%pg_stat_activity%'
        ORDER BY query_start DESC;
    COMMIT;
  `)
  } catch (e: any) {
    logger.error(
      `Error running clearRunningQueries: ${e.message}. Continuing with content node setup`
    )
  }
}
