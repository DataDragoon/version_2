import { useEffect, useRef, useState } from 'react';
import SarWorker from '../lib/sar.worker.js?worker';

export function useSarWorker(bscanData, bscanParams, sarParams, svdEnabled, svdK) {
  const [sarResult, setSarResult] = useState(null);
  const [sarProgress, setSarProgress] = useState(null);
  const workerRef = useRef(null);
  const debounceRef = useRef(null);
  const jobIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!bscanData || bscanData.length < 2) {
      setSarResult(null);
      setSarProgress(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      // Terminate stale worker and start fresh
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      const jobId = ++jobIdRef.current;
      setSarProgress(0);

      const worker = new SarWorker();
      workerRef.current = worker;
      worker.onmessage = (e) => {
        if (jobIdRef.current !== jobId) return;
        if (e.data.type === 'progress') {
          setSarProgress(e.data.progress);
        } else if (e.data.type === 'result') {
          setSarResult(e.data.result);
          setSarProgress(null);
        }
      };
      worker.postMessage({ bscanData, bscanParams, sarParams, svdEnabled, svdK });
    }, 300);
  }, [bscanData, bscanParams, sarParams, svdEnabled, svdK]);

  return { sarResult, sarProgress };
}
