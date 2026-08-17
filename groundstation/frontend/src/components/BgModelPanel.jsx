import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

const LIDAR_AVG_WINDOW = 20;

export default function BgModelPanel({ isConnected, sdrConnected, sfcwRunning, modelCaptures, modelCapturing, accumCount, testing, testCount, testResult, trainingState, trainProgress, trainResult, trainError, onModelAction, lidarMm }) {
  const [modelName, setModelName] = useState('');
  const lidarBuf = useRef([]);
  const [lidarAvg, setLidarAvg] = useState(null);

  useEffect(() => {
    if (lidarMm == null) return;
    const buf = lidarBuf.current;
    buf.push(lidarMm);
    if (buf.length > LIDAR_AVG_WINDOW) buf.shift();
    const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
    setLidarAvg(avg);
  }, [lidarMm]);

  const canActivate = isConnected && sdrConnected;
  const captureCount = modelCaptures.length;

  const allDistances = modelCaptures.flatMap(c => c.samples.map(s => s.lidar_standoff_mm));
  const totalSamples = allDistances.length;
  const distRange = totalSamples > 0
    ? { min: Math.min(...allDistances), max: Math.max(...allDistances) }
    : null;

  return (
    <>
      <Section label="Session">
        <button
          onClick={() => onModelAction(sfcwRunning ? 'stop_session' : 'start_session')}
          disabled={!canActivate}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sfcwRunning
              ? 'bg-orange-500/8 border-orange-500/30 hover:border-orange-500/50'
              : canActivate
                ? 'bg-[#a78bfa]/8 border-[#a78bfa]/30 hover:border-[#a78bfa]/50'
                : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sfcwRunning ? 'bg-orange-500/15' : canActivate ? 'bg-[#a78bfa]/15' : 'bg-white/5',
          )}>
            {sfcwRunning ? (
              <div className="w-3 h-3 rounded-sm bg-orange-400" />
            ) : (
              <div className="w-3 h-3 rounded-full border-2 border-current text-[#a78bfa]" />
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {sfcwRunning ? 'Stop Session' : 'Start Modeling'}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {sfcwRunning ? 'Sweeping continuously...' :
               !sdrConnected ? 'SDR not connected' : 'Start continuous sweep'}
            </span>
          </div>
        </button>
      </Section>

      <Section label="Capture">
        <button
          onClick={() => onModelAction('capture')}
          disabled={!sfcwRunning || modelCapturing}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sfcwRunning && !modelCapturing
              ? 'bg-[#a78bfa]/8 border-[#a78bfa]/30 hover:border-[#a78bfa]/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sfcwRunning && !modelCapturing ? 'bg-[#a78bfa]/15' : 'bg-white/5',
          )}>
            {modelCapturing ? (
              <div className="w-3 h-3 rounded-full border-2 border-[#a78bfa] border-t-transparent animate-spin" />
            ) : (
              <svg className="w-4 h-4 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {modelCapturing ? `Capturing ${accumCount}/5` : 'Capture Background'}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {modelCapturing ? 'Collecting sweeps...' :
               !sfcwRunning ? 'Start session first' :
               `${captureCount} sample${captureCount !== 1 ? 's' : ''} captured`}
            </span>
          </div>
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onModelAction('undo')}
            disabled={captureCount === 0}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              captureCount > 0
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Undo Last
          </button>
          <button
            onClick={() => onModelAction('clear')}
            disabled={captureCount === 0}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              captureCount > 0
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Clear All
          </button>
        </div>
      </Section>

      <Section label="Standoff">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-3 py-2 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Live</span>
            <span className="text-base font-bold font-mono text-white">
              {lidarAvg != null ? lidarAvg.toFixed(1) : '—'} <span className="text-xs font-semibold text-[#888888]">mm</span>
            </span>
          </div>
        </div>
      </Section>

      <Section label="Training Data">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Captures" value={`${captureCount} (${totalSamples})`} />
          <InfoTile label="Range" value={distRange ? `${((distRange.max - distRange.min) / 10).toFixed(1)} cm` : '—'} />
        </div>
        {distRange && (
          <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
            {distRange.min.toFixed(1)} mm — {distRange.max.toFixed(1)} mm
          </div>
        )}
        {captureCount > 0 && (
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto px-2">
            {[...modelCaptures].reverse().map((c, ri) => {
              const i = captureCount - 1 - ri;
              const dists = c.samples.map(s => s.lidar_standoff_mm);
              const avg = dists.reduce((s, v) => s + v, 0) / dists.length;
              return (
                <div key={i} className="flex flex-col gap-0.5">
                  <div className="flex justify-between text-[10px] text-white/50">
                    <span>#{i + 1}</span>
                    <span className="font-mono">{avg.toFixed(1)} mm</span>
                  </div>
                  <div className="text-[9px] text-white/30 font-mono pl-4">
                    [{dists.map(d => d != null ? d.toFixed(1) : '?').join(', ')}]
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section label="Phase Test">
        <button
          onClick={() => onModelAction('test_phase')}
          disabled={!sfcwRunning || testing || modelCapturing}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            testing
              ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
              : sfcwRunning && !modelCapturing
                ? 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          {testing ? `Testing ${testCount}/5...` : 'Test Phase Unwind'}
        </button>
        {testResult && (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Round-trip error</span>
              <span className={cn('font-mono font-bold', testResult.maxErrorOverall < 1e-10 ? 'text-green-400' : 'text-red-400')}>
                {testResult.maxErrorOverall.toExponential(2)}
              </span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Residual SNR</span>
              <span className="font-mono font-bold text-white">{testResult.residualSnrDb.toFixed(1)} dB</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Sweep correlation</span>
              <span className={cn('font-mono font-bold', testResult.residualCorrelation > 0.95 ? 'text-green-400' : testResult.residualCorrelation > 0.8 ? 'text-yellow-400' : 'text-red-400')}>
                {testResult.residualCorrelation.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Lidar spread</span>
              <span className="font-mono font-bold text-white">
                {(Math.max(...testResult.distances) - Math.min(...testResult.distances)).toFixed(1)} mm
              </span>
            </div>
            <div className="text-[9px] text-white/30 leading-relaxed pt-1 border-t border-white/5">
              Round-trip should be ~0 (lossless). High correlation = residuals are consistent across sweeps (good for model learning).
            </div>
          </div>
        )}
      </Section>

      <Section label="Data">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onModelAction('export')}
            disabled={captureCount === 0 || sfcwRunning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              captureCount > 0 && !sfcwRunning
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Export
          </button>
          <button
            onClick={() => onModelAction('import')}
            disabled={sfcwRunning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              !sfcwRunning
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Import
          </button>
        </div>
      </Section>

      <Section label="Model">
        <button
          onClick={() => onModelAction('build')}
          disabled={totalSamples < 5 || trainingState === 'training'}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            trainingState === 'training'
              ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
              : totalSamples >= 5
                ? 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa] hover:bg-[#a78bfa]/20'
                : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          {trainingState === 'training' ? 'Training...' : 'Build Model'}
        </button>

        {trainingState === 'training' && trainProgress && (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-yellow-500/20 bg-yellow-500/5">
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Epoch</span>
              <span className="font-mono text-white">{trainProgress.epoch} / {trainProgress.totalEpochs}</span>
            </div>
            <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-yellow-500 to-yellow-300 transition-all duration-300"
                style={{ width: `${(trainProgress.epoch / trainProgress.totalEpochs) * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-[#555]">Loss</span>
              <span className="font-mono text-white">{trainProgress.loss.toExponential(3)}</span>
            </div>
          </div>
        )}

        {trainingState === 'error' && trainError && (
          <div className="p-3 rounded-xl border border-red-500/20 bg-red-500/5">
            <span className="text-xs text-red-400">{trainError}</span>
          </div>
        )}

        {trainingState === 'complete' && trainResult && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1 p-3 rounded-xl border border-green-500/20 bg-green-500/5">
              <div className="flex justify-between text-[10px]">
                <span className="text-[#555]">Final loss</span>
                <span className="font-mono text-green-400">{trainResult.finalLoss.toExponential(3)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-[#555]">Samples</span>
                <span className="font-mono text-white">{trainResult.numSamples}</span>
              </div>
            </div>
            <input
              type="text"
              value={modelName}
              onChange={e => setModelName(e.target.value)}
              placeholder="Model name..."
              className="w-full px-3 py-2 rounded-lg text-xs bg-[#0a0a0a] border border-white/10 text-white outline-none focus:border-[#a78bfa]/50 placeholder:text-[#333]"
              spellCheck={false}
            />
            <button
              onClick={() => {
                if (modelName.trim()) {
                  onModelAction('save_model', modelName.trim());
                  setModelName('');
                }
              }}
              disabled={!modelName.trim()}
              className={cn(
                'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
                modelName.trim()
                  ? 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20'
                  : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              )}
            >
              Save Model
            </button>
          </div>
        )}
      </Section>
    </>
  );
}
