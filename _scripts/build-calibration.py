"""Export EdgeSAM's official Core ML wrapper for two clicks + its padding point.
Run from a pinned EdgeSAM checkout with torch/coremltools installed:
  PYTHONPATH=/path/to/EdgeSAM python _scripts/build-calibration.py checkpoint.pth output-dir
Then: xcrun coremlcompiler compile output-dir/edge_sam_encoder.mlpackage native/bin
      xcrun coremlcompiler compile output-dir/edge_sam_decoder.mlpackage native/bin
"""
import argparse
from pathlib import Path
import torch
import coremltools as ct
from edge_sam import sam_model_registry
from edge_sam.utils.coreml import SamCoreMLModel

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('checkpoint')
parser.add_argument('output')
args = parser.parse_args()
out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
sam = sam_model_registry['edge_sam'](checkpoint=args.checkpoint, upsample_mode='bilinear').eval()
decoder = SamCoreMLModel(model=sam).eval()
inputs = (torch.randn(1, 256, 64, 64), torch.tensor([[[300., 300.], [500., 500.], [0., 0.]]]), torch.tensor([[1., 1., -1.]]))
traced = torch.jit.trace(decoder, inputs)
ct.convert(traced, inputs=[ct.TensorType(name=name, shape=value.shape) for name, value in zip(['image_embeddings', 'point_coords', 'point_labels'], inputs)], outputs=[ct.TensorType(name='scores'), ct.TensorType(name='masks')], convert_to='mlprogram').save(str(out / 'edge_sam_decoder.mlpackage'))
sam.forward = sam.forward_dummy_encoder
image = torch.randn(1, 3, 1024, 1024)
ct.convert(torch.jit.trace(sam, image), inputs=[ct.TensorType(name='image', shape=image.shape)], outputs=[ct.TensorType(name='image_embeddings')], convert_to='mlprogram').save(str(out / 'edge_sam_encoder.mlpackage'))
