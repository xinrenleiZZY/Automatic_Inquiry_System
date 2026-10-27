"""比价表简洁字段归一化回归测试。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import repo


CASES = [
    ({"moq": "1件起批"}, "moq", "1（件）"),
    ({"moq": "500套起订"}, "moq", "500（套）"),
    ({"moq": "一张起订"}, "moq", "1（张）"),
    ({"freight": "商品不含运费"}, "freight", "不含运费"),
    ({"freight": "包邮"}, "freight", "包邮"),
    ({"freight": "运费另议"}, "freight", "运费另议"),
    ({"sample_lead_time": "打样周期约48小时（首样）"}, "sample_lead_time", "48小时（首样）"),
    ({"bulk_lead_time": "大货交期约2至3天左右"}, "bulk_lead_time", "2-3天"),
    ({"bulk_lead_time": "1000多张，10-15天左右（400套起）"}, "bulk_lead_time", "10-15天"),
    ({"sample_fee_refundable": "大货可退还"}, "sample_fee_refundable", "可退"),
    ({"sample_fee_refundable": "打样费不退"}, "sample_fee_refundable", "不退"),
    ({"price_incl_sample_fee": "125元/套"}, "price_incl_sample_fee", "¥125"),
    ({"defect_rate": "次品率约1%左右"}, "defect_rate", "1%"),
    ({"nda": "支持签订保密协议"}, "nda", "可签"),
]

for source, key, expected in CASES:
    actual = repo.compare_summary_fields(source)[key]
    assert actual == expected, f"{source} => {actual!r}, expected {expected!r}"

headers, rows = repo.compare_export_rows([], concise=True)
assert headers[4:12] == [
    "起订量", "运费", "打样工期", "大货工期", "打样费可退",
    "大货不退含样费价", "次品率", "保密协议",
]
assert rows == []

print("compare-summary: PASS")
