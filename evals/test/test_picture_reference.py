"""A camera pan or a still can look like the right shot without identifying the source frame."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
try:
    import cv2
    import numpy as np
    from verify_pictures import camera_crop, match_three, verify
except ModuleNotFoundError as e:
    if e.name not in ("cv2", "numpy"):
        raise
    cv2 = None


@unittest.skipUnless(cv2, "picture-reference preparation uses OpenCV and NumPy")
class PictureReferenceTests(unittest.TestCase):
    def test_declines_picture_observations_for_a_different_audio_reference(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "reference-audio.json").write_text('{"inputs":{"sourceSha256":"cam","editorSha256":"other"},"joins":[]}')
            with patch("verify_pictures.probe_frames", side_effect=[([], [], "cam"), ([], [], "published")]):
                with self.assertRaisesRegex(ValueError, "different published edit"):
                    verify(root, root / "cache")
            self.assertFalse((root / "pictures.json").exists())

    def test_requires_unique_source_motion_and_three_matching_frames(self):
        rng = np.random.default_rng(3)
        frames = rng.integers(10, 200, (25, 32, 48)).astype("float32")
        target = frames[8:11] * .9 + 2
        self.assertEqual(match_three(frames, target, .002)[0], 8)
        self.assertIsNone(match_three(frames, target[::-1], .002))
        frames[17:20] = frames[8:11]
        self.assertIsNone(match_three(frames, target, .002))
        still = np.repeat(frames[:1], 25, axis=0)
        self.assertIsNone(match_three(still, still[:3], .002))

    def test_finds_the_zoomed_camera_inside_the_published_frame(self):
        rng = np.random.default_rng(4)
        source = cv2.GaussianBlur(rng.integers(0, 255, (46, 80), dtype=np.uint8), (5, 5), 1.5)
        published = cv2.resize(source[6:40, 8:68], (80, 46))
        region, mx, my, _ = camera_crop(source, published, (0, 0, 1, 1))
        transformed = cv2.remap(source, mx, my, cv2.INTER_LINEAR)
        self.assertGreater(np.corrcoef(published[region].ravel(), transformed.ravel())[0, 1], .98)
