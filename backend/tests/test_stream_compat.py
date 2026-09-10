"""Published stream-manifest boundary for historical uploaders.

Overlap recovery itself is not asserted here: it runs inside
``ReplayService._stream`` so it can fingerprint source lines instead of holding
every historical record in memory. See
``test_services.ServiceTests.test_overlapping_native_stream_recovers_without_retaining_update_history``
for that behaviour.
"""
import unittest
from backend.parsers.atif_stream import descriptors, MANIFEST_VERSION, STREAM_VERSION
from backend.oss_io.client import OssProtocolError


def manifest(chunks, total):
    value = {'trace_format': 'atif-stream', 'stream_schema_version': STREAM_VERSION,
             'manifest_schema_version': MANIFEST_VERSION, 'chunks': chunks, 'total_lines': total}
    descriptors(value)
    return value


class StreamManifestTests(unittest.TestCase):
    def test_published_layouts_are_accepted(self):
        # Historical uploaders may republish an overlapping tail; identical
        # sequenced overlaps are recoverable, so the manifest stays valid.
        value = manifest([{'start': 0, 'count': 3}, {'start': 2, 'count': 3},
                          {'start': 4, 'count': 2}], 6)
        self.assertEqual([chunk['start'] for chunk in value['chunks']], [0, 2, 4])
        # A trailing unpublished tail is valid as well.
        self.assertEqual(len(manifest([{'start': 0, 'count': 3}], 2)['chunks']), 1)

    def test_non_contiguous_and_overlong_layouts_are_rejected(self):
        for chunks, total in (
            ([{'start': 1, 'count': 1}], 4),                            # does not start at 0
            ([{'start': 0, 'count': 2}, {'start': 3, 'count': 1}], 4),  # gap
            ([{'start': 0, 'count': 3}, {'start': 2, 'count': 1}], 4),  # regressing start
            ([{'start': 0, 'count': 3}, {'start': 1, 'count': 2}], 4),  # unknown overlap
            ([{'start': 0, 'count': 3}], 0),                            # total below coverage
        ):
            with self.assertRaises(OssProtocolError):
                manifest(chunks, total)

    def test_legacy_manifest_requires_exact_contiguity(self):
        value = {'schema_version': '2.0', 'chunks': [{'start': 0, 'count': 2}], 'total_lines': 2}
        self.assertEqual(len(descriptors(value, legacy=True)), 1)
        for chunks, total in (
            ([{'start': 0, 'count': 2}, {'start': 2, 'count': 1}], 2),   # overlong
            ([{'start': 0, 'count': 1}], 2),                            # short
            ([{'start': 0, 'count': 2}, {'start': 1, 'count': 1}], 3),   # overlap
        ):
            with self.assertRaises(OssProtocolError):
                descriptors({'schema_version': '2.0', 'chunks': chunks, 'total_lines': total},
                            legacy=True)
