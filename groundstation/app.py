"""Groundstation web application. Serves the Vite-built frontend.

For development: run `npm run dev` in groundstation/frontend/ (port 5173).
For production: run `npm run build` then `python app.py` (port 5000).
"""

from flask import Flask, send_from_directory
import os

DIST_DIR = os.path.join(os.path.dirname(__file__), 'frontend', 'dist')

app = Flask(__name__, static_folder=DIST_DIR)


@app.route('/')
def index():
    return send_from_directory(DIST_DIR, 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(DIST_DIR, path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
