const { expect } = require('chai')
const sinon = require('sinon')
const { Sequelize, QueryTypes } = require('sequelize')

const { up, down } = require('../../../server/migrations/v2.38.0-add-duplicate-detection-tables')
const Database = require('../../../server/Database')

/**
 * Normalized column definitions for a table: name -> type/notnull/pk/default
 */
async function describeColumns(sequelize, table) {
  const columns = await sequelize.query(`PRAGMA table_info(\`${table}\`)`, { type: QueryTypes.SELECT })
  return Object.fromEntries(columns.map((c) => [c.name, { type: c.type, notnull: c.notnull, pk: c.pk, dflt: c.dflt_value }]))
}

async function describeForeignKeys(sequelize, table) {
  const keys = await sequelize.query(`PRAGMA foreign_key_list(\`${table}\`)`, { type: QueryTypes.SELECT })
  return keys.map((k) => `${k.from}->${k.table}.${k.to} ${k.on_delete}`).sort()
}

async function describeIndexes(sequelize, table) {
  const indexes = await sequelize.query(`PRAGMA index_list(\`${table}\`)`, { type: QueryTypes.SELECT })
  const result = {}
  for (const index of indexes.filter((i) => i.origin === 'c')) {
    const cols = await sequelize.query(`PRAGMA index_info(\`${index.name}\`)`, { type: QueryTypes.SELECT })
    result[index.name] = { unique: index.unique, columns: cols.map((c) => c.name) }
  }
  return result
}

describe('Migration v2.38.0-add-duplicate-detection-tables', () => {
  let sequelize
  let queryInterface
  let logger

  beforeEach(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    queryInterface = sequelize.getQueryInterface()
    logger = { info: sinon.stub(), error: sinon.stub() }
    // Existing tables the new tables reference
    await sequelize.query('CREATE TABLE users (id UUID PRIMARY KEY)')
    await sequelize.query('CREATE TABLE libraries (id UUID PRIMARY KEY)')
    await sequelize.query('CREATE TABLE libraryItems (id UUID PRIMARY KEY, libraryId UUID REFERENCES libraries (id) ON DELETE CASCADE)')
  })

  afterEach(async () => {
    await sequelize.close()
  })

  it('creates both tables with indexes and foreign keys', async () => {
    await up({ context: { queryInterface, logger } })

    expect(await queryInterface.tableExists('duplicateFindings')).to.be.true
    expect(await queryInterface.tableExists('fileHashes')).to.be.true

    const findingKeys = await describeForeignKeys(sequelize, 'duplicateFindings')
    expect(findingKeys).to.deep.equal(['dismissedByUserId->users.id SET NULL', 'libraryId->libraries.id CASCADE', 'libraryItemAId->libraryItems.id CASCADE', 'libraryItemBId->libraryItems.id CASCADE'])
    expect(await describeForeignKeys(sequelize, 'fileHashes')).to.deep.equal(['libraryId->libraries.id CASCADE'])

    const findingIndexes = await describeIndexes(sequelize, 'duplicateFindings')
    expect(findingIndexes.duplicate_findings_library_item_a_id_library_item_b_id).to.deep.equal({ unique: 1, columns: ['libraryItemAId', 'libraryItemBId'] })
    expect(findingIndexes.duplicate_findings_library_id_status_classification.columns).to.deep.equal(['libraryId', 'status', 'classification'])
    const hashIndexes = await describeIndexes(sequelize, 'fileHashes')
    expect(hashIndexes.file_hashes_path).to.deep.equal({ unique: 1, columns: ['path'] })

    expect(logger.info.calledWith('[2.38.0 migration] UPGRADE BEGIN: 2.38.0-add-duplicate-detection-tables')).to.be.true
    expect(logger.info.calledWith('[2.38.0 migration] UPGRADE END: 2.38.0-add-duplicate-detection-tables')).to.be.true
  })

  it('creates the same schema as the models', async () => {
    await up({ context: { queryInterface, logger } })

    const modelSequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    const previous = Database.sequelize
    try {
      Database.sequelize = modelSequelize
      Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
      await Database.buildModels()
      for (const table of ['duplicateFindings', 'fileHashes']) {
        expect(await describeColumns(sequelize, table), table).to.deep.equal(await describeColumns(modelSequelize, table))
        expect(await describeForeignKeys(sequelize, table), table).to.deep.equal(await describeForeignKeys(modelSequelize, table))
        expect(await describeIndexes(sequelize, table), table).to.deep.equal(await describeIndexes(modelSequelize, table))
      }
    } finally {
      Database.sequelize = previous
      await modelSequelize.close()
    }
  })

  it('cascades deletes of library items to findings', async () => {
    await up({ context: { queryInterface, logger } })
    await sequelize.query('PRAGMA foreign_keys = ON')
    await sequelize.query(`INSERT INTO libraries (id) VALUES ('lib')`)
    await sequelize.query(`INSERT INTO libraryItems (id, libraryId) VALUES ('a', 'lib'), ('b', 'lib')`)
    await sequelize.query(`INSERT INTO duplicateFindings (id, classification, status, createdAt, updatedAt, libraryId, libraryItemAId, libraryItemBId) VALUES ('f', 'exact', 'open', '2026-01-01', '2026-01-01', 'lib', 'a', 'b')`)
    await sequelize.query(`DELETE FROM libraryItems WHERE id = 'b'`)
    const [rows] = await sequelize.query('SELECT * FROM duplicateFindings')
    expect(rows).to.have.length(0)
  })

  it('is idempotent', async () => {
    await up({ context: { queryInterface, logger } })
    await up({ context: { queryInterface, logger } })
    expect(logger.info.calledWith('[2.38.0 migration] table "duplicateFindings" already exists')).to.be.true
    expect(logger.info.calledWith('[2.38.0 migration] table "fileHashes" already exists')).to.be.true
  })

  it('down drops both tables and leaves other tables alone', async () => {
    await up({ context: { queryInterface, logger } })
    await down({ context: { queryInterface, logger } })
    expect(await queryInterface.tableExists('duplicateFindings')).to.be.false
    expect(await queryInterface.tableExists('fileHashes')).to.be.false
    expect(await queryInterface.tableExists('libraryItems')).to.be.true
    // Running down again is safe
    await down({ context: { queryInterface, logger } })
    expect(logger.info.calledWith('[2.38.0 migration] table "fileHashes" does not exist')).to.be.true
  })
})
