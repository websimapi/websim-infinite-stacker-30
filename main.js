import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';

// Global state
let game, ui, replayRecorder, canvasUI, audioManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;
let currentScore = 0;
let isScoreSubmitted = false;
let replayBlobPromise = null;
let replayUrlPromise = null;
let pendingSubmissions = []; // Track background submissions

const room = new WebsimSocket();

function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: async (score) => {
            currentScore = score;
            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');

            // Wait 3 seconds to capture falling blocks
            await new Promise(resolve => setTimeout(resolve, 3000));

            if (!replayRecorder) {
                console.error("No replay recorder found on game over.");
                autoSubmitScore(null, score);
                return;
            }
            
            // stop() now returns a promise that resolves with the blob
            const blob = await replayRecorder.stop();
            
            replayBlobPromise = Promise.resolve(blob);

            ui.setReplayButtonState(false, 'Watch Replay');
            
            if (!isScoreSubmitted) {
                autoSubmitScore(blob, score);
            }
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    // Subscribe to all scores for the public leaderboard
    room.collection('score_v1').subscribe(scores => {
        const sortedScores = scores.sort((a, b) => b.score - a.score);
        ui.updateLeaderboard(sortedScores, (replayUrl) => {
            ui.showReplayViewer(replayUrl);
        });
    });

    renderer.setAnimationLoop(animate);
    startGame();
}

function startGame() {
    game.start();
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
    replayBlobPromise = null;
    replayUrlPromise = null;
    isScoreSubmitted = false;
    
    replayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
}

function restart() {
    // No longer need to manually stop, as it happens in onGameOver
    // if (replayRecorder && replayRecorder.isRecording) {
    //     replayRecorder.stop();
    // }
    game.restart();
    startGame();
}

async function autoSubmitScore(replayBlob, scoreToSubmit) {
    if (!replayBlob) {
        console.warn("Auto-submit cancelled: no replay blob.");
        return;
    }

    // Add visual indicator to trophy button
    const leaderboardButton = document.getElementById('leaderboard-button');
    leaderboardButton.classList.add('uploading');
    leaderboardButton.textContent = '⏳';

    const submissionPromise = (async () => {
        let isScoreSubmitted = false; // Local state for this submission
        try {
            const currentUser = await window.websim.getCurrentUser();
            if (!currentUser) {
                console.error('Could not get user info for submission.');
                return;
            }

            // Get the user's current scores.
            const allScores = room.collection('score_v1').getList();
            const userScores = allScores.filter(score => score.username === currentUser.username);
            userScores.sort((a, b) => a.score - b.score);

            let shouldSubmit = false;
            let lowestScoreRecord = null;

            if (userScores.length < 3) {
                shouldSubmit = true;
            } else {
                lowestScoreRecord = userScores[0];
                if (scoreToSubmit > lowestScoreRecord.score) {
                    shouldSubmit = true;
                }
            }

            if (!shouldSubmit) {
                console.log('Score too low for leaderboard.');
                // We still want to remove the uploading indicator eventually
                return;
            }
            
            let replayUrl = null;
            if (replayBlob) {
                if (replayBlob.size === 0) {
                     console.error("Replay is empty, cannot submit.");
                     return;
                }

                try {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    replayUrl = await window.websim.upload(replayBlob);
                    
                    if (!replayUrl || replayUrl.length === 0) {
                        throw new Error('Upload returned invalid URL');
                    }
                    
                    const response = await fetch(replayUrl, { method: 'HEAD' });
                    if (!response.ok) {
                        throw new Error('Uploaded file not accessible');
                    }
                } catch (uploadError) {
                    console.error("Replay upload failed:", uploadError);
                    if (ui.gameOverElement.classList.contains('hidden') === false) {
                        ui.setSubmitStatus('Replay upload failed. Score not submitted.', '#f44336');
                    }
                    return; 
                }
            } else {
                 if (ui.gameOverElement.classList.contains('hidden') === false) {
                    ui.setSubmitStatus('No replay available. Score not submitted.', '#f44336');
                }
                return;
            }

            if (!replayUrl) {
                console.error('Replay upload incomplete. Score not submitted.');
                return;
            }

            if (ui.gameOverElement.classList.contains('hidden') === false) {
                 ui.setSubmitStatus('Saving to leaderboard...', '#ff9800');
            }

            if (lowestScoreRecord && userScores.length >= 3) {
                await room.collection('score_v1').update(lowestScoreRecord.id, { score: scoreToSubmit, replayUrl });
                 if (ui.gameOverElement.classList.contains('hidden') === false) {
                    ui.setSubmitStatus('High score updated!', '#4CAF50');
                }
            } else {
                await room.collection('score_v1').create({
                    score: scoreToSubmit,
                    replayUrl,
                });
                if (ui.gameOverElement.classList.contains('hidden') === false) {
                    ui.setSubmitStatus('Score submitted!', '#4CAF50');
                }
            }
            isScoreSubmitted = true;

        } catch (error) {
            console.error("Failed to auto-submit score:", error);
            if (ui.gameOverElement.classList.contains('hidden') === false) {
                ui.setSubmitStatus('Error submitting score.', '#f44336');
            }
        } finally {
            // This block runs regardless of success or failure
            if (isScoreSubmitted) {
                leaderboardButton.classList.remove('uploading');
                leaderboardButton.classList.add('upload-complete');
                leaderboardButton.textContent = '✅';
                
                setTimeout(() => {
                    leaderboardButton.classList.remove('upload-complete');
                    leaderboardButton.textContent = '🏆';
                }, 3000);
            } else {
                 // If submission failed or was skipped, just reset the icon
                 leaderboardButton.classList.remove('uploading');
                 leaderboardButton.textContent = '🏆';
            }
        }
    })();

    pendingSubmissions.push(submissionPromise);
    submissionPromise.finally(() => {
        const index = pendingSubmissions.indexOf(submissionPromise);
        if (index > -1) {
            pendingSubmissions.splice(index, 1);
        }
    });
}

async function viewReplay() {
    if (!replayBlobPromise) {
        // Fallback for cases where submission might have failed before blob was ready
        if (replayRecorder) {
            replayBlobPromise = replayRecorder.getReplayBlob();
        } else {
            alert("Replay not available.");
            return;
        }
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        const blob = await replayBlobPromise;
        if (blob) {
            ui.showReplayViewer(blob);
        } else {
            alert("Replay data is not available.");
        }
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay');
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in autoSubmitScore.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(currentScore);
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (pendingSubmissions.length > 0) {
            event.preventDefault();
            event.returnValue = ''; // For Chrome
            return "Your score is still uploading. Are you sure you want to leave?"; // For older browsers
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();