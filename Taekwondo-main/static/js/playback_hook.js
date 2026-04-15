// 非侵入式回放掛鉤：不改動原本主程式
(function(){
    function createPlaybackSection(){
        if (document.getElementById('playback-section')) return;
        const main = document.querySelector('main');
        if (!main) return;
        const wrap = document.createElement('section');
        wrap.className = 'playback-section';
        wrap.id = 'playback-section';
        wrap.style.display = 'none';
        wrap.style.marginTop = '24px';
        wrap.innerHTML = [
          '<div class="download-panel">',
          '  <h3><i class="fas fa-play-circle"></i> 錄製回放</h3>',
          '  <p class="download-description">錄完影片後，會自動在這裡顯示並可直接播放。</p>',
          '  <div style="width:100%;">',
          '    <video id="recorded-player" controls playsinline style="width:100%; max-height:520px; border-radius:12px;"></video>',
          '  </div>',
          '  <div class="download-options" style="margin-top:12px;">',
          '    <button id="play-original-btn" class="control-btn info"><i class="fas fa-video"></i> 播放原始影片</button>',
          '    <button id="play-analysis-btn" class="control-btn success"><i class="fas fa-chart-line"></i> 播放分析影片</button>',
          '    <span id="recording-duration" class="stat-value" style="margin-left:12px;"></span>',
          '  </div>',
          '</div>'
        ].join('');
        main.appendChild(wrap);
    }

    function showPlayback(recordingData){
        createPlaybackSection();
        const section = document.getElementById('playback-section');
        const player = document.getElementById('recorded-player');
        const playOriginalBtn = document.getElementById('play-original-btn');
        const playAnalysisBtn = document.getElementById('play-analysis-btn');
        const durationElement = document.getElementById('recording-duration');
        if (!section || !player) return;
        if (recordingData && recordingData.original_video){
            player.src = '/download_recording/' + recordingData.original_video;
        }
        if (durationElement && recordingData && recordingData.duration){
            durationElement.textContent = (recordingData.duration).toFixed
                ? (recordingData.duration).toFixed(1) + '秒'
                : recordingData.duration + '秒';
        }
        if (playOriginalBtn){
            playOriginalBtn.onclick = function(){
                if (recordingData.original_video){
                    player.src = '/download_recording/' + recordingData.original_video;
                    player.play();
                }
            };
        }
        if (playAnalysisBtn){
            playAnalysisBtn.onclick = function(){
                if (recordingData.skeleton_video){
                    player.src = '/download_recording/' + recordingData.skeleton_video;
                    player.play();
                }
            };
        }
        section.style.display = 'block';
    }

    // 等待全域實例就緒後包裝 updateDownloadLinks
    function tryHook(){
        var mgr = window.taekwondoDetailManager;
        if (!mgr || typeof mgr.updateDownloadLinks !== 'function'){
            setTimeout(tryHook, 300);
            return;
        }
        var original = mgr.updateDownloadLinks.bind(mgr);
        mgr.updateDownloadLinks = function(recordingData){
            try { showPlayback(recordingData); } catch(e){ console.error(e); }
            return original(recordingData);
        };
        console.log('[playback_hook] 已掛鉤 updateDownloadLinks');
    }
    // 頁面載入後啟動
    if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', tryHook);
    } else {
        tryHook();
    }
})();
