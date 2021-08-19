# Notate (Jupyter Notebook Extension)
#### 1. Tear open HTML canvases and draw on them.
Use Ctrl+\ (Backslash) to inject a canvas at the cursor position in the selected cell.
#### 2. Canvases are auto-passed to Python as 2d NumPy arrays (images) upon run.
Actually, they act as variable names. On the run of each cell, code is silently injected which declares the variables and sets them equal to NumPy image data. (This performs a number of imports: base64, numpy as np, io.BytesIO, and PIL.Image. If you pass the image as a single argument to a function (e.g. foo(*canvas*)) it will also pass the locals() dict as the '.locals' attribute of the nparray object.)
#### 3. Do what you want with the output.
Pass handwritten digits to an MNIST recognizer for all I care!

## Required Libraries
- PIL library (so from PIL import Image works)
- NumPy library
