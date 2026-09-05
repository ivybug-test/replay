"""Historical upload-boundary compatibility shared with the prior Node reader."""
import unittest
from backend.parsers.atif_stream import descriptors, assemble_records, MANIFEST_VERSION, STREAM_VERSION
from backend.oss_io.client import OssProtocolError


def record(n):
    return {'stream_sequence':n, 'message':str(n)}


def manifest(chunks,total):
    value={'trace_format':'atif-stream','stream_schema_version':STREAM_VERSION,
           'manifest_schema_version':MANIFEST_VERSION,'chunks':chunks,'total_lines':total}
    descriptors(value)
    return value


class StreamCompatibilityTests(unittest.TestCase):
    def test_overlaps_require_identical_sequenced_records(self):
        meta=manifest([{'start':0,'count':3},{'start':2,'count':3},{'start':4,'count':2}],6)
        parts=[[record(n) for n in values] for values in ([1,2,3],[3,4,5],[5,6])]
        records,duplicates=assemble_records(meta,parts)
        self.assertEqual([r['stream_sequence'] for r in records],[1,2,3,4,5,6])
        self.assertEqual(duplicates,2)
        parts[1][0]['message']='conflict'
        with self.assertRaises(OssProtocolError): assemble_records(meta,parts)

    def test_unpublished_tail_is_not_exposed_and_gaps_rejected(self):
        meta=manifest([{'start':0,'count':3}],2)
        parts=[[record(n) for n in (1,2,3)]]
        self.assertEqual(len(assemble_records(meta,parts)[0]),2)
        parts[0][-1]['stream_sequence']=99
        with self.assertRaises(OssProtocolError): assemble_records(meta,parts)
        for chunks in ([{'start':1,'count':1}], [{'start':0,'count':2},{'start':3,'count':1}],
                       [{'start':0,'count':3},{'start':2,'count':1}]):
            with self.assertRaises(OssProtocolError): manifest(chunks,4)
