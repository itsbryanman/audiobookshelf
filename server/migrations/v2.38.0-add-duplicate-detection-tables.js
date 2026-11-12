/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a Sequelize QueryInterface object.
 * @property {import('../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.38.0'
const migrationName = `${migrationVersion}-add-duplicate-detection-tables`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * This upward migration creates the duplicateFindings and fileHashes tables used by duplicate detection.
 * No existing tables or data are changed.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)
  const DataTypes = queryInterface.sequelize.Sequelize.DataTypes

  if (await queryInterface.tableExists('duplicateFindings')) {
    logger.info(`${loggerPrefix} table "duplicateFindings" already exists`)
  } else {
    logger.info(`${loggerPrefix} creating table "duplicateFindings"`)
    await queryInterface.createTable('duplicateFindings', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      classification: {
        type: DataTypes.STRING,
        allowNull: false
      },
      evidence: DataTypes.JSON,
      limitations: DataTypes.JSON,
      contentSignature: DataTypes.STRING,
      algorithmVersion: DataTypes.INTEGER,
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'open'
      },
      statusReason: DataTypes.STRING,
      firstDetectedAt: DataTypes.DATE,
      lastVerifiedAt: DataTypes.DATE,
      dismissedAt: DataTypes.DATE,
      dismissedClassification: DataTypes.STRING,
      dismissedContentSignature: DataTypes.STRING,
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      libraryId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: { tableName: 'libraries' }, key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      libraryItemAId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: { tableName: 'libraryItems' }, key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      libraryItemBId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: { tableName: 'libraryItems' }, key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      dismissedByUserId: {
        type: DataTypes.UUID,
        references: { model: { tableName: 'users' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }
    })
    await queryInterface.addIndex('duplicateFindings', {
      name: 'duplicate_findings_library_item_a_id_library_item_b_id',
      unique: true,
      fields: ['libraryItemAId', 'libraryItemBId']
    })
    await queryInterface.addIndex('duplicateFindings', {
      name: 'duplicate_findings_library_item_b_id',
      fields: ['libraryItemBId']
    })
    await queryInterface.addIndex('duplicateFindings', {
      name: 'duplicate_findings_library_id_status_classification',
      fields: ['libraryId', 'status', 'classification']
    })
    logger.info(`${loggerPrefix} created table "duplicateFindings"`)
  }

  if (await queryInterface.tableExists('fileHashes')) {
    logger.info(`${loggerPrefix} table "fileHashes" already exists`)
  } else {
    logger.info(`${loggerPrefix} creating table "fileHashes"`)
    await queryInterface.createTable('fileHashes', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      path: {
        type: DataTypes.STRING,
        allowNull: false
      },
      size: DataTypes.BIGINT,
      mtimeMs: DataTypes.DOUBLE,
      ctimeMs: DataTypes.DOUBLE,
      ino: DataTypes.STRING,
      dev: DataTypes.STRING,
      algorithm: DataTypes.STRING,
      cacheVersion: DataTypes.INTEGER,
      hash: DataTypes.STRING,
      hashedAt: DataTypes.DATE,
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      libraryId: {
        type: DataTypes.UUID,
        references: { model: { tableName: 'libraries' }, key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      }
    })
    await queryInterface.addIndex('fileHashes', { name: 'file_hashes_path', unique: true, fields: ['path'] })
    await queryInterface.addIndex('fileHashes', { name: 'file_hashes_library_id', fields: ['libraryId'] })
    await queryInterface.addIndex('fileHashes', { name: 'file_hashes_ino_size', fields: ['ino', 'size'] })
    logger.info(`${loggerPrefix} created table "fileHashes"`)
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * This downward migration drops the duplicateFindings and fileHashes tables.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  for (const table of ['duplicateFindings', 'fileHashes']) {
    if (await queryInterface.tableExists(table)) {
      logger.info(`${loggerPrefix} dropping table "${table}"`)
      await queryInterface.dropTable(table)
    } else {
      logger.info(`${loggerPrefix} table "${table}" does not exist`)
    }
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
