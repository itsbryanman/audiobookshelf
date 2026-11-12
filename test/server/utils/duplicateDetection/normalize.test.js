const { expect } = require('chai')
const normalize = require('../../../../server/utils/duplicateDetection/normalize')

describe('duplicateDetection/normalize', () => {
  describe('normalizeTitle', () => {
    it('folds case, accents, punctuation and whitespace', () => {
      expect(normalize.normalizeTitle('  Café   Society!  ')).to.equal('cafe society')
      expect(normalize.normalizeTitle('CAFE SOCIETY')).to.equal('cafe society')
      expect(normalize.normalizeTitle('Café—Society')).to.equal('cafe society')
    })

    it('treats different Unicode representations of the same text as equal', () => {
      const composed = 'Les Misérables' // é as one code point
      const decomposed = 'Les Misérables' // e + combining acute accent
      expect(composed).to.not.equal(decomposed)
      expect(normalize.normalizeTitle(composed)).to.equal(normalize.normalizeTitle(decomposed))
      // Full-width characters (NFKD compatibility)
      expect(normalize.normalizeTitle('ＤＵＮＥ')).to.equal('dune')
    })

    it('treats apostrophe variants and & consistently', () => {
      expect(normalize.normalizeTitle("Ender's Game")).to.equal(normalize.normalizeTitle('Ender’s Game'))
      expect(normalize.normalizeTitle('Pride & Prejudice')).to.equal(normalize.normalizeTitle('Pride and Prejudice'))
    })

    it('ignores a leading or trailing article', () => {
      expect(normalize.normalizeTitle('The Hobbit')).to.equal('hobbit')
      expect(normalize.normalizeTitle('Hobbit, The')).to.equal('hobbit')
      expect(normalize.normalizeTitle('A Game of Thrones')).to.equal('game of thrones')
      // Only articles that were configured are removed
      expect(normalize.normalizeTitle('Der Hobbit', ['the'])).to.equal('der hobbit')
      expect(normalize.normalizeTitle('Der Hobbit', ['der'])).to.equal('hobbit')
    })

    it('does not strip a title that is only an article', () => {
      expect(normalize.normalizeTitle('The')).to.equal('the')
    })

    it('removes bracketed release noise only', () => {
      expect(normalize.normalizeTitle('Dune (Unabridged)')).to.equal('dune')
      expect(normalize.normalizeTitle('Dune [MP3, 64kbps]')).to.equal('dune')
      expect(normalize.normalizeTitle('Dune {128k}')).to.equal('dune')
      expect(normalize.normalizeTitle('Dune - Audiobook')).to.equal('dune')
    })

    it('keeps volume, edition and abridged markers that change meaning', () => {
      expect(normalize.normalizeTitle('Dune (Book 2)')).to.equal('dune book 2')
      expect(normalize.normalizeTitle('Dune (Revised Edition)')).to.equal('dune revised edition')
      expect(normalize.normalizeTitle('Dune (Abridged)')).to.equal('dune abridged')
      expect(normalize.normalizeTitle('Dune (Book 1)')).to.not.equal(normalize.normalizeTitle('Dune (Book 2)'))
    })

    it('returns empty string for missing titles', () => {
      expect(normalize.normalizeTitle(null)).to.equal('')
      expect(normalize.normalizeTitle(undefined)).to.equal('')
      expect(normalize.normalizeTitle('   ')).to.equal('')
    })
  })

  describe('normalizePersonName', () => {
    it('normalizes different author formats to the same key', () => {
      const expected = 'j r r tolkien'
      expect(normalize.normalizePersonName('J.R.R. Tolkien')).to.equal(expected)
      expect(normalize.normalizePersonName('J. R. R. Tolkien')).to.equal(expected)
      expect(normalize.normalizePersonName('Tolkien, J.R.R.')).to.equal(expected)
      expect(normalize.normalizePersonName('tolkien,  j r r')).to.equal(expected)
    })

    it('does not reorder name suffixes', () => {
      expect(normalize.normalizePersonName('Martin Luther King, Jr.')).to.equal('martin luther king jr')
    })

    it('folds accents', () => {
      expect(normalize.normalizePersonName('Gabriel García Márquez')).to.equal('gabriel garcia marquez')
    })
  })

  describe('personSurnameInitialKey', () => {
    it('builds a surname + first initial key', () => {
      expect(normalize.personSurnameInitialKey('john ronald tolkien')).to.equal('tolkien j')
      expect(normalize.personSurnameInitialKey('j r r tolkien')).to.equal('tolkien j')
      expect(normalize.personSurnameInitialKey('plato')).to.equal('plato')
    })
  })

  describe('normalizePersonList', () => {
    it('drops empty and duplicate names and sorts', () => {
      expect(normalize.normalizePersonList(['Stephen King', '', 'King, Stephen', 'Peter Straub'])).to.deep.equal(['peter straub', 'stephen king'])
      expect(normalize.normalizePersonList(null)).to.deep.equal([])
    })
  })

  describe('normalizeIsbn', () => {
    it('converts ISBN-10 to ISBN-13 so both forms match', () => {
      expect(normalize.normalizeIsbn('0-306-40615-2')).to.equal('9780306406157')
      expect(normalize.normalizeIsbn('978-0-306-40615-7')).to.equal('9780306406157')
      expect(normalize.normalizeIsbn('080442957X')).to.equal('9780804429573')
    })

    it('rejects values that are not ISBNs', () => {
      expect(normalize.normalizeIsbn('12345')).to.equal('')
      expect(normalize.normalizeIsbn('')).to.equal('')
      expect(normalize.normalizeIsbn(null)).to.equal('')
    })
  })

  describe('normalizeAsin', () => {
    it('uppercases and validates', () => {
      expect(normalize.normalizeAsin(' b00test001 ')).to.equal('B00TEST001')
      expect(normalize.normalizeAsin('B00')).to.equal('')
      expect(normalize.normalizeAsin(undefined)).to.equal('')
    })
  })

  describe('normalizeLanguage', () => {
    it('maps common names and codes to the same value', () => {
      expect(normalize.normalizeLanguage('English')).to.equal('en')
      expect(normalize.normalizeLanguage('eng')).to.equal('en')
      expect(normalize.normalizeLanguage('en-US')).to.equal('en')
      expect(normalize.normalizeLanguage('Deutsch')).to.equal('de')
      expect(normalize.normalizeLanguage('')).to.equal('')
    })
  })

  describe('textSaysAbridged', () => {
    it('detects abridged but not unabridged', () => {
      expect(normalize.textSaysAbridged('Dune (Abridged)')).to.be.true
      expect(normalize.textSaysAbridged('Dune (Unabridged)')).to.be.false
      expect(normalize.textSaysAbridged('Dune')).to.be.false
      expect(normalize.textSaysAbridged(null)).to.be.false
    })
  })
})
