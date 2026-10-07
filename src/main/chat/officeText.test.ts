import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { officeText } from './officeText'

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

describe('officeText', () => {
  it('reads a Word document paragraph by paragraph', () => {
    const doc = zip({
      'word/document.xml':
        '<w:document><w:body>' +
        '<w:p><w:r><w:t>Quarterly </w:t></w:r><w:r><w:t xml:space="preserve">report &amp; plan</w:t></w:r></w:p>' +
        '<w:p></w:p>' +
        '<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t></w:r></w:p>' +
        '</w:body></w:document>',
      'word/styles.xml': '<w:styles/>'
    })
    expect(officeText('docx', doc)).toBe('Quarterly report & plan\nName\tValue')
  })

  it('reads slides in order', () => {
    const deck = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml':
        '<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Subtitle</a:t></a:r></a:p></p:sld>'
    })
    expect(officeText('pptx', deck)).toBe(
      'Slide 1\nTitle\nSubtitle\n\nSlide 2\nSecond\n\nSlide 3\nLast'
    )
  })

  it('reads every sheet as tab-separated rows, keeping empty columns', () => {
    const book = zip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Costs" sheetId="1"/><sheet name="Notes" sheetId="2"/></sheets></workbook>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Item</t></si><si><t>Price</t></si><si><r><t>Coff</t></r><r><t>ee</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4.5</v></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>'
    })
    expect(officeText('xlsx', book)).toBe(
      'Sheet: Costs\nItem\t\tPrice\nCoffee\t\t4.5\n\nSheet: Notes\n\thello'
    )
  })
})
