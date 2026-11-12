const { DataTypes, Model } = require('sequelize')

/**
 * Cached content hash of an audio file, used by duplicate detection.
 *
 * A cached hash is only reused when the file still has the same size and
 * mtime and the cache entry was written with the current cacheVersion.
 * After a rename or move the path no longer matches, so the entry is looked
 * up by device + inode + size + mtime instead. The inode is never trusted
 * on its own.
 */
class FileHash extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {number} */
    this.id
    /** @type {UUIDV4} */
    this.libraryId
    /** @type {string} absolute path, never sent to clients */
    this.path
    /** @type {number} */
    this.size
    /** @type {number} */
    this.mtimeMs
    /** @type {number} */
    this.ctimeMs
    /** @type {string} */
    this.ino
    /** @type {string} */
    this.dev
    /** @type {string} */
    this.algorithm
    /** @type {number} */
    this.cacheVersion
    /** @type {string} */
    this.hash
    /** @type {Date} */
    this.hashedAt
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * Bump when hashing or cache semantics change so older entries are ignored
   */
  static CACHE_VERSION = 1

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
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
        hashedAt: DataTypes.DATE
      },
      {
        sequelize,
        modelName: 'fileHash',
        indexes: [
          {
            unique: true,
            fields: ['path']
          },
          {
            fields: ['libraryId']
          },
          {
            fields: ['ino', 'size']
          }
        ]
      }
    )

    const { library } = sequelize.models
    library.hasMany(FileHash, {
      onDelete: 'CASCADE'
    })
    FileHash.belongsTo(library)
  }
}

module.exports = FileHash
