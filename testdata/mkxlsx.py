# -*- coding: utf-8 -*-
# 造一个「教务系统风格」的 xlsx 当测试夹具：共享字符串 + 合并单元格 + 空列
import zipfile, os

out = r'D:\kebiao\_test\demo.xlsx'
os.makedirs(os.path.dirname(out), exist_ok=True)

# 共享字符串表
shared = [
    '节次', '星期一', '星期二', '星期三', '星期四', '星期五',          # 0-5
    '1-2节', '3-4节', '5-6节', '7-8节',                              # 6-9
    '高等数学A 张伟 理科楼302 1-16周',                                # 10
    '大学英语 李娜 外语楼205 1-16周',                                 # 11
    '计算机网络 王强 信息楼401 1-12周',                               # 12
    '数据结构与算法 赵鹏 信息楼502 1-16周',                            # 13
    '体育(篮球) 刘洋 体育馆 1-16周(单周)',                            # 14
    '毛泽东思想概论 陈静 文科楼108 2-16周(双周)',                      # 15
    '2026-2027学年第一学期  第1周开始日期：2026-09-07',                # 16
]

def c(ref, idx):
    """共享字符串单元格"""
    return '<c r="%s" t="s"><v>%d</v></c>' % (ref, idx)

rows = []
# 第1行：学期说明（跨列合并 A1:F1）
rows.append('<row r="1">' + c('A1', 16) + '</row>')
# 第2行：表头
rows.append('<row r="2">' + ''.join(c(chr(65 + i) + '2', i) for i in range(6)) + '</row>')
# 第3行：1-2节  周一高数 / 周三英语
rows.append('<row r="3">' + c('A3', 6) + c('B3', 10) + c('D3', 11) + '</row>')
# 第4行：3-4节  周二计网 / 周五数据结构
rows.append('<row r="4">' + c('A4', 7) + c('C4', 12) + c('F4', 13) + '</row>')
# 第5行：5-6节  周四体育
rows.append('<row r="5">' + c('A5', 8) + c('E5', 14) + '</row>')
# 第6行：7-8节  周三毛概
rows.append('<row r="6">' + c('A6', 9) + c('D6', 15) + '</row>')

sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
         '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
         '<sheetData>' + ''.join(rows) + '</sheetData>'
         '<mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>'
         '</worksheet>')

sst = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">'
       % (len(shared), len(shared)) +
       ''.join('<si><t>%s</t></si>' % x.replace('&', '&amp;').replace('<', '&lt;') for x in shared) +
       '</sst>')

ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Default Extension="xml" ContentType="application/xml"/>'
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      '</Types>')

rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>')

wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      '<sheets><sheet name="大二上" sheetId="1" r:id="rId1"/></sheets></workbook>')

wbrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
          '</Relationships>')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('xl/workbook.xml', wb)
    z.writestr('xl/_rels/workbook.xml.rels', wbrels)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
    z.writestr('xl/sharedStrings.xml', sst)

print('written', out, os.path.getsize(out), 'bytes')
