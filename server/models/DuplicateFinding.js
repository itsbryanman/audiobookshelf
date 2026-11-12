const { DataTypes, Model } = require('sequelize')

/**
 * A duplicate finding between two library items in the same library.
 *
 * Findings are stored per pair because fuzzy matches are not transitive:
 * A~B and B~C does not mean A~C. libraryItemAId is always the lower id.
 *
 * Status values:
 *  - open: needs review
 *  - dismissed: an admin marked it as not a duplicate
 */
class DuplicateFinding extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.libraryId
    /** @type {UUIDV4} */
    this.libraryItemAId
    /** @type {UUIDV4} */
    this.libraryItemBId
    /** @type {string} exact | likely_same_recording | possible_duplicate | shared_files */
    this.classification
    /** @type {import('../utils/duplicateDetection/classify').Evidence[]} */
    this.evidence
    /** @type {string[]} */
    this.limitations
    /** @type {string} audio content signatures of both items, used to reconsider dismissals */
    this.contentSignature
    /** @type {number} */
    this.algorithmVersion
    /** @type {string} open | dismissed */
    this.status
    /** @type {string} why the status was last changed */
    this.statusReason
    /** @type {Date} */
    this.firstDetectedAt
    /** @type {Date} */
    this.lastVerifiedAt
    /** @type {Date} */
    this.dismissedAt
    /** @type {UUIDV4} */
    this.dismissedByUserId
    /** @type {string} */
    this.dismissedClassification
    /** @type {string} */
    this.dismissedContentSignature
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  static Status = {
    OPEN: 'open',
    DISMISSED: 'dismissed'
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
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
        dismissedContentSignature: DataTypes.STRING
      },
      {
        sequelize,
        modelName: 'duplicateFinding',
        indexes: [
          {
            unique: true,
            fields: ['libraryItemAId', 'libraryItemBId']
          },
          {
            fields: ['libraryItemBId']
          },
          {
            fields: ['libraryId', 'status', 'classification']
          }
        ]
      }
    )

    const { library, libraryItem, user } = sequelize.models

    library.hasMany(DuplicateFinding, {
      onDelete: 'CASCADE',
      foreignKey: { allowNull: false }
    })
    DuplicateFinding.belongsTo(library)

    libraryItem.hasMany(DuplicateFinding, {
      as: 'duplicateFindingsAsA',
      foreignKey: { name: 'libraryItemAId', allowNull: false },
      onDelete: 'CASCADE'
    })
    DuplicateFinding.belongsTo(libraryItem, { as: 'libraryItemA', foreignKey: { name: 'libraryItemAId', allowNull: false }, onDelete: 'CASCADE' })

    libraryItem.hasMany(DuplicateFinding, {
      as: 'duplicateFindingsAsB',
      foreignKey: { name: 'libraryItemBId', allowNull: false },
      onDelete: 'CASCADE'
    })
    DuplicateFinding.belongsTo(libraryItem, { as: 'libraryItemB', foreignKey: { name: 'libraryItemBId', allowNull: false }, onDelete: 'CASCADE' })

    user.hasMany(DuplicateFinding, {
      as: 'duplicateFindingsDismissed',
      foreignKey: 'dismissedByUserId',
      onDelete: 'SET NULL'
    })
    DuplicateFinding.belongsTo(user, { as: 'dismissedByUser', foreignKey: 'dismissedByUserId', onDelete: 'SET NULL' })
  }
}

module.exports = DuplicateFinding
