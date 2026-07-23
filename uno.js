(function () {
    let scene;
    let currentScript = document.currentScript;

    const MAX_PLAYERS = 10; // Uno typically 2-10 players
    const MAX_HAND_CARDS = 20; // Uno can have many cards in hand
    const TURN_DURATION = 90 * 1000; // 90 seconds in milliseconds
    const DISCONNECT_TIMEOUT_MS = 45000; // 45 seconds grace period

    class UnoGame {
        constructor() {
            this.gameState = null;
            this.selectedCardIds = [];
            this.ui = {
                slices: [],
                centralPanel: null,
                colorChoiceRow: null, // Will be initialized dynamically
                confirmButtonsRow: null, // To control visibility of default confirm/cancel buttons
            };
            this.isConfirmationDialogOpen = false;
            this.confirmCallback = null;
            this.isMuted = false;
            this.playersInitiallyLoaded = {}; // Track initial disconnected state for sound suppression
            this.joinTime = Date.now(); // Timestamp when this client first fully synced the game state
            this.firstSyncDone = false; // Flag to ensure playersInitiallyLoaded is set only once

            const urlParams = new URLSearchParams(window.location.search);
            const getParam = (attr, defaultValue) => {
                return urlParams.get(attr) ||
                       (currentScript && currentScript.getAttribute(attr)) ||
                       (currentScript && currentScript.dataset?.[attr]) ||
                       defaultValue;
            };

            this.params = {
                position: getParam("position", "0 0 0"),
                rotation: getParam("rotation", "0 0 0"),
                instance: getParam("instance", "demo-uno"), // Unique instance for Uno
                debug: getParam("debug", "false") === "true"
            };
            this.stateKey = this.params.instance; // Changed STATE_KEY to this.stateKey
        }

        parseVector3(str) {
            const parts = str.split(" ").map(parseFloat);
            return new BS.Vector3(parts[0] || 0, parts[1] || 0, parts[2] || 0);
        }

        log(...args) {
            if (this.params.debug) console.log("[UNO Banter]", ...args);
        }

        playLocalSound(soundFile) {
            if (this.isMuted) return;
            const now = Date.now();
            this.audioTracker = this.audioTracker || {};
            if (this.audioTracker[soundFile] && now - this.audioTracker[soundFile] < 100) return;
            this.audioTracker[soundFile] = now;

            // Sound assets.
            const soundMap = {
                "join": "https://uno.firer.at/Assets/playerJoin.ogg",
                "leave": "https://uno.firer.at/Assets/playerKick.ogg",
                "start": "https://uno.firer.at/Assets/gameStart.ogg",
                "play_card": "https://uno.firer.at/Assets/card_flick.ogg",
                "draw_card": "https://uno.firer.at/Assets/card_flick.ogg",
                "uno": "https://uno.firer.at/Assets/ding%20ding.ogg",
                "win": "https://uno.firer.at/Assets/fanfare%20with%20pop.ogg",
                "pass": "https://uno.firer.at/Assets/ding%20ding.ogg"
            };
            const url = soundMap[soundFile];
            if (!url) {
                this.log("Sound not found:", soundFile);
                return;
            }

            const audio = new Audio(url);
            audio.crossOrigin = "anonymous";
            audio.volume = 0.3;
            audio.play().catch(e => this.log("Audio play failed: " + e.message));
        }

        async init() {
            if (scene) return;
            scene = BS.BanterScene.GetInstance();

            // Wait for Unity to load before proceeding with anything that depends on scene.localUser or scene.space
            if (!scene.unityLoaded) {
                await new Promise(resolve => {
                    scene.On("unity-loaded", resolve);
                    window.addEventListener("unity-loaded", resolve, { once: true });
                });
            }

            this.log("Initializing Uno Game...");
            await this.buildEnvironment();

            // Setup BanterSpace state for state management AFTER unity is loaded
            scene.On("space-state-changed", this.onSpaceStateChanged.bind(this));
            scene.On("user-left", this.onSpaceUserLeft.bind(this)); // Listen for user leaving the space
            // Trigger initial state sync immediately after registering the listener
            this.sync();

            setInterval(() => this.tick(), 1000); // Renamed tickTimers to tick
        }

        async buildEnvironment() {
            const rootPos = this.parseVector3(this.params.position);
            const rootRot = this.parseVector3(this.params.rotation);
            this.root = await new BS.GameObject({ name: "UNO_Root", localPosition: rootPos, localEulerAngles: rootRot }).Async();

            // Main Table Base (Circle)
            const tableObj = await new BS.GameObject({ name: "UNO_TableBase", parent: this.root, localPosition: new BS.Vector3(0, 1, 0), localEulerAngles: new BS.Vector3(90, 0, 0) }).Async();
            await tableObj.AddComponent(new BS.BanterCircle({
                radius: 1.5,
                segments: 32,
                thetaStart: 0,
                thetaLength: Math.PI * 2
            }));
            await tableObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.08, 0.08, 0.1, 1) }));

            // Center Deck Box (Draw Pile)
            const deckObj = await new BS.GameObject({ name: "UNO_DrawPile", parent: this.root, localPosition: new BS.Vector3(-0.2, 1.05, 0) }).Async();
            await deckObj.AddComponent(new BS.BanterBox({ width: 0.3, height: 0.1, depth: 0.2 }));
            await deckObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.15, 0.15, 0.15, 1) }));

            // Center Discard Pile
            const discardObj = await new BS.GameObject({ name: "UNO_DiscardPile", parent: this.root, localPosition: new BS.Vector3(0.2, 1.05, 0) }).Async();
            await discardObj.AddComponent(new BS.BanterBox({ width: 0.3, height: 0.1, depth: 0.2 }));
            await discardObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.15, 0.15, 0.15, 1) }));

            // Player Slices
            this.ui.slices = [];
            for (let i = 0; i < MAX_PLAYERS; i++) {
                this.ui.slices.push(await this.buildPlayerSlice(i));
            }

            // Central Hub UI
            await this.buildCentralUI();

            this.log("Environment built.");
        }

        async buildPlayerSlice(index) {
            const angleDeg = (360 / MAX_PLAYERS) * index;
            const sliceRoot = await new BS.GameObject({
                name: `UNO_PlayerSlice_${index}`,
                parent: this.root,
                localEulerAngles: new BS.Vector3(0, angleDeg, 0)
            }).Async();

            // Geometric Wedge for the placemat
            const wedgeObj = await new BS.GameObject({ name: "UNO_Placemat", parent: sliceRoot, localPosition: new BS.Vector3(0, 1.01, 0), localEulerAngles: new BS.Vector3(90, 0, 0) }).Async();
            const sliceAngleRad = Math.PI * 2 / MAX_PLAYERS;
            await wedgeObj.AddComponent(new BS.BanterCircle({
                radius: 1.6,
                segments: 8,
                thetaStart: (Math.PI / 2) - (sliceAngleRad * 0.95) / 2,
                thetaLength: sliceAngleRad * 0.95
            }));
            const matNormal = await wedgeObj.AddComponent(new BS.BanterMaterial(
                "Unlit/Color",
                null,
                new BS.Vector4(0.15, 0.15, 0.15, 1),
                0, // BS.MaterialSide.Front
                false,
                "UNO_Wedge_" + index
            ));

            // 1. Status Bar UI (Always visible if player is present, near table edge)
            const statusObj = await new BS.GameObject({
                name: "UNO_StatusUI",
                parent: sliceRoot,
                localPosition: new BS.Vector3(0, 1.15, 1.55),
                localEulerAngles: new BS.Vector3(35, 180, 0),
                localScale: new BS.Vector3(0.10, 0.10, 0.10)
            }).Async();

            const sPanel = await statusObj.AddComponent(new BS.BanterUI(new BS.Vector2(750, 130), false));
            const sRoot = sPanel.CreateVisualElement();
            await sRoot.Async();
            sRoot.SetStyles({
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                display: 'none',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
                paddingTop: '30px',
                paddingBottom: '30px',
                paddingLeft: '30px',
                paddingRight: '30px',
                borderRadius: '40px',
                borderWidth: '4px',
                borderColor: 'rgba(102, 102, 102, 1)'
            });

            const nameText = sPanel.CreateLabel(undefined, sRoot);
            await nameText.Async();
            nameText.text = "Empty Seat";
            nameText.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'white', fontSize: '28px', fontWeight: 'bold', marginRight: '40px', marginLeft: '15px' }); // Added marginRight

            const statusText = sPanel.CreateLabel(undefined, sRoot);
            await statusText.Async();
            statusText.text = "";
            statusText.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(255, 204, 0, 1)', fontSize: '25px', marginRight: '40px' }); // Added marginRight

            const timerText = sPanel.CreateLabel(undefined, sRoot);
            await timerText.Async();
            timerText.text = "";
            timerText.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgba(255, 51, 51, 1)', fontSize: '20px', fontWeight: 'bold' });

            // 2. Hand UI (Only visible to local user, floating/tilted)
            const handObj = await new BS.GameObject({
                name: "UNO_HandUI",
                parent: sliceRoot,
                localPosition: new BS.Vector3(0, 1.35, 1.18),
                localEulerAngles: new BS.Vector3(60, 180, 0),
                localScale: new BS.Vector3(0.08, 0.08, 0.08)
            }).Async();

            const hPanel = await handObj.AddComponent(new BS.BanterUI(new BS.Vector2(900, 900), false));
            const hRoot = hPanel.CreateVisualElement();
            await hRoot.Async();
            hRoot.SetStyles({
                backgroundColor: 'rgba(25, 25, 25, 0.93)',
                display: 'none',
                flexDirection: 'column',
                alignItems: 'center',
                width: '100%',
                height: '100%',
                paddingTop: '20px',
                paddingRight: '20px',
                paddingBottom: '20px',
                paddingLeft: '20px',
                borderRadius: '25px',
                borderWidth: '3px',
                borderColor: 'rgba(102, 102, 102, 1)'
            });

            // Set the panel's root to transparent to prevent white background bleed-through
            if (hRoot.parent && hRoot.parent.SetStyles) {
                hRoot.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)' });
            }

            const actionsRow = hPanel.CreateVisualElement(hRoot);
            await actionsRow.Async();
            actionsRow.SetStyles({
                display: 'flex',
                flexDirection: 'row',
                marginBottom: '20px',
                backgroundColor: 'rgba(0, 0, 0, 0)' // This should be fully transparent
            });

            const selectionLabel = hPanel.CreateLabel(undefined, actionsRow);
            await selectionLabel.Async();
            selectionLabel.text = "";
            selectionLabel.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'white', fontSize: '28px', fontWeight: 'bold', marginRight: '20px' });

            const createBtn = async (pnl, parent, text, color, handler) => {
                const btn = pnl.CreateButton(parent);
                await btn.Async();
                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '12px', fontSize: '25px', borderWidth: '0px', marginRight: '20px' }); // Added marginRight
                btn.OnClick(handler);
                return btn;
            };

            const playBtn = await createBtn(hPanel, actionsRow, "PLAY CARD", "#4CAF50", () => {
                if (this.selectedCardIds.length > 0) {
                    const localPlayer = this.gameState.players[scene.localUser.uid];
                    const cardToPlay = localPlayer.hand.find(c => c.id === this.selectedCardIds[0]);

                    // For wild cards, we just confirm playing the card. Color choice happens after the state update.
                    if (cardToPlay && (cardToPlay.type === "wild" || cardToPlay.type === "wild_draw_4")) {
                        this.confirm("Play this Wild card?", () => {
                            this.sendAction("play-card", { cardId: this.selectedCardIds[0] });
                            this.selectedCardIds = [];
                        });
                    } else {
                        this.confirm("Play this card?", () => {
                            this.sendAction("play-card", { cardId: this.selectedCardIds[0] });
                            this.selectedCardIds = [];
                        });
                    }
                }
            });
            const drawBtn = await createBtn(hPanel, actionsRow, "DRAW CARD", "#FF9800", () => {
                this.confirm("Draw a card?", () => {
                    this.sendAction("draw-card");
                    this.selectedCardIds = [];
                });
            });
            const passBtn = await createBtn(hPanel, actionsRow, "PASS", "#607D8B", () => {
                this.confirm("Pass your turn?", () => {
                    this.sendAction("pass-turn");
                    this.selectedCardIds = [];
                });
            });
            const unoBtn = await createBtn(hPanel, actionsRow, "UNO!", "#F44336", () => {
                this.sendAction("call-uno");
            });
            const turnIndicatorBtn = await createBtn(hPanel, actionsRow, "WAITING...", "#444444", () => {});

            const cardsScroll = hPanel.CreateScrollView(hRoot);
            await cardsScroll.Async();
            cardsScroll.SetStyles({
                width: '100%',
                height: '800px',
                backgroundColor: 'rgba(0, 0, 0, 0)',
                marginBottom: '20px',
                overflow: 'scroll'
            });

            const cardsGrid = hPanel.CreateVisualElement(cardsScroll);
            await cardsGrid.Async();
            cardsGrid.SetStyles({
                display: 'flex',
                flexWrap: 'wrap',
                flexDirection: 'row',
                justifyContent: 'center',
                width: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0)'
            });

            const cardUIs = [];
            for (let i = 0; i < MAX_HAND_CARDS; i++) {
                const cardContainer = hPanel.CreateVisualElement(cardsGrid);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '180px',
                    height: '250px',
                    backgroundColor: 'rgba(51, 51, 51, 1)',
                    padding: '15px',
                    borderRadius: '12px',
                    borderWidth: '4px',
                    borderColor: 'rgba(170, 170, 170, 1)',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginRight: '12px',
                    marginBottom: '12px'
                });

                const cardLabel = hPanel.CreateLabel("", cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    width: '100%',
                    height: '100%',
                    color: '#000000',
                    fontSize: '30px',
                    fontWeight: 'bold',
                    textAlign: 'center'
                });

                cardContainer.OnClick(() => this.onCardClick(i));
                cardUIs.push({ container: cardContainer, label: cardLabel });
            }

            // --- Confirmation Overlay (Moved to Hand UI) ---
            const confirmOverlay = hPanel.CreateVisualElement(hRoot);
            await confirmOverlay.Async();
            confirmOverlay.SetStyles({
                display: 'none',
                position: 'absolute',
                top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: '20px',
                paddingBottom: '20px',
                paddingLeft: '20px',
                paddingRight: '20px',
                borderRadius: '25px'
            });

            const confirmMsg = hPanel.CreateLabel(undefined, confirmOverlay);
            await confirmMsg.Async();
            confirmMsg.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'white', fontSize: '36px', marginBottom: '20px', fontWeight: 'bold' });

            const confirmButtonsRow = hPanel.CreateVisualElement(confirmOverlay);
            await confirmButtonsRow.Async();
            confirmButtonsRow.SetStyles({
                display: 'none',
                flexDirection: 'row',
                backgroundColor: 'rgba(0, 0, 0, 0)'
            });

            await createBtn(hPanel, confirmButtonsRow, "CANCEL", "#F44336", () => {
                this.isConfirmationDialogOpen = false;
                confirmOverlay.SetStyles({ display: 'none' });
            });
            await createBtn(hPanel, confirmButtonsRow, "CONFIRM", "#4CAF50", () => {
                if (this.confirmCallback) this.confirmCallback();
                this.isConfirmationDialogOpen = false;
                confirmOverlay.SetStyles({ display: 'none' });
            });

            const colorChoiceRow = hPanel.CreateVisualElement(confirmOverlay);
            await colorChoiceRow.Async();
            colorChoiceRow.SetStyles({
                display: 'none',
                flexDirection: 'row',
                marginBottom: '30px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const createColorBtn = async (colorName, hexColor) => {
                const btn = hPanel.CreateButton(colorChoiceRow);
                await btn.Async();
                btn.text = colorName.toUpperCase();
                btn.SetStyles({
                    backgroundColor: hexColor,
                    color: colorName === "YELLOW" ? "black" : "white",
                    paddingTop: '15px',
                    paddingBottom: '15px',
                    paddingLeft: '30px',
                    paddingRight: '30px',
                    borderRadius: '12px',
                    fontSize: '25px',
                    borderWidth: '0px',
                    marginRight: '20px'
                });
                btn.OnClick(() => {
                    if (this.confirmCallback) this.confirmCallback(colorName.toLowerCase());
                });
            };

            await createColorBtn("RED", "#F44336");
            await createColorBtn("BLUE", "#2196F3");
            await createColorBtn("GREEN", "#4CAF50");
            await createColorBtn("YELLOW", "#FFEB3B");

            // Swap choice row for 7-0 rule (pre-create MAX_PLAYERS buttons to avoid runtime leaks)
            const swapChoiceRow = hPanel.CreateVisualElement(confirmOverlay);
            await swapChoiceRow.Async();
            swapChoiceRow.SetStyles({
                display: 'none',
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'center',
                marginBottom: '20px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const swapPlayerBtns = [];
            for (let si = 0; si < MAX_PLAYERS; si++) {
                const swapBtn = hPanel.CreateButton(swapChoiceRow);
                await swapBtn.Async();
                swapBtn.text = "";
                swapBtn.SetStyles({
                    display: 'none',
                    backgroundColor: '#2196F3',
                    color: 'white',
                    paddingTop: '12px',
                    paddingBottom: '12px',
                    paddingLeft: '20px',
                    paddingRight: '20px',
                    borderRadius: '10px',
                    fontSize: '22px',
                    borderWidth: '0px',
                    marginRight: '10px',
                    marginBottom: '10px'
                });
                swapBtn.OnClick(() => {
                    if (this.confirmCallback && swapBtn._swapTargetId) {
                        this.confirmCallback(swapBtn._swapTargetId);
                    }
                });
                swapPlayerBtns.push(swapBtn);
            }

            return {
                root: sliceRoot,
                wedgeMat: matNormal,
                statusObj, sRoot, nameText, statusText, timerText,
                handObj, hRoot, actionsRow, playBtn, drawBtn, passBtn, unoBtn, selectionLabel, cardsGrid, cardUIs,
                confirmOverlay, confirmMsg, confirmButtonsRow, colorChoiceRow, swapChoiceRow, swapPlayerBtns, hPanel, turnIndicatorBtn
            };
        }

        async buildCentralUI() {
            const centralObj = await new BS.GameObject({ name: "UNO_CentralUI", parent: this.root, localPosition: new BS.Vector3(0, 2.0, 0), localScale: new BS.Vector3(0.15, 0.15, 0.15) }).Async();
            let centralBillboardObj = await centralObj.AddComponent(new BS.BanterBillboard({ smoothing: 1, enableXAxis: false, enableYAxis: true }));
            centralBillboardObj.enableXAxis = false;

            const panel = await centralObj.AddComponent(new BS.BanterUI(new BS.Vector2(900, 1000), false));
            const rootEl = panel.CreateVisualElement();
            await rootEl.Async();

            rootEl.SetStyles({
                backgroundColor: 'rgba(10, 10, 10, 0.9)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: '20px',
                paddingBottom: '20px',
                paddingLeft: '20px',
                paddingRight: '20px',
                borderRadius: '25px',
                borderWidth: '4px',
                borderColor: 'rgba(74, 78, 105, 1)',
                width: '900px',
                height: '1050px',
                position: 'absolute',
                top: '0',
                left: '0'
            });

            // Set the central panel's root to transparent
            if (rootEl.parent && rootEl.parent.SetStyles) {
                rootEl.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)' });
            }

            this.ui.centralPanel = { obj: centralObj, panel, rootEl };

            const title = panel.CreateLabel(undefined, rootEl);
            await title.Async();
            title.text = "UNO!";
            title.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: 'white', fontSize: '42px', fontWeight: 'bold', marginBottom: '15px' });
            this.ui.titleLabel = title;

            const statusLabel = panel.CreateLabel(undefined, rootEl);
            await statusLabel.Async();
            statusLabel.text = "";
            statusLabel.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#ffcc00', fontSize: '24px', marginBottom: '15px', display: 'none' });
            this.ui.statusLabel = statusLabel;

            const buttonsRow = panel.CreateVisualElement(rootEl);
            await buttonsRow.Async();
            buttonsRow.SetStyles({
                display: 'flex',
                flexDirection: 'row',
                marginBottom: '20px',
                backgroundColor: 'rgba(0, 0, 0, 0)',
                paddingTop: '5px',
                paddingBottom: '5px',
                paddingLeft: '5px',
                paddingRight: '5px',
                marginTop: '5px',
                marginBottom: '5px',
                marginLeft: '5px',
                marginRight: '5px'
            });

            const createBtn = async (parent, text, color, handler) => {
                const btn = panel.CreateButton(parent);
                await btn.Async();

                if (btn.parent && btn.parent.SetStyles) {
                    btn.parent.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
                }

                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '8px', fontSize: '24px', borderWidth: '0px', backgroundImage: 'none', margin: '8px' });
                btn.OnClick(handler);
                return btn;
            };

            this.ui.joinBtn = await createBtn(buttonsRow, "JOIN GAME", "#2196F3", () => this.sendAction("join-game"));
            this.ui.dealBtn = await createBtn(buttonsRow, "START GAME", "#4CAF50", () => this.sendAction("start-game"));
            this.ui.leaveBtn = await createBtn(buttonsRow, "LEAVE GAME", "#F44336", () => this.sendAction("leave-game"));
            this.ui.muteBtn = await createBtn(buttonsRow, "🔊", "#607D8B", () => {
                this.isMuted = !this.isMuted;
                this.ui.muteBtn.text = this.isMuted ? "🔇" : "🔊";
            });
            this.ui.claimHostBtn = await createBtn(buttonsRow, "CLAIM HOST", "#e69900", () => {
                if (!this.isHost()) { // Only allow claiming if not already host
                    this.updateState({ currentHostUid: scene.localUser.uid });
                }
            });

            const creditLabel = panel.CreateLabel(undefined, rootEl);
            await creditLabel.Async();
            creditLabel.text = "UNO! is a registered trademark of Mattel, Inc.\nAdapted for Banter by FireRat\nBeta v0.3.2";
            creditLabel.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#aaaaaa', fontSize: '25px', marginTop: '20px', textAlign: 'center' });
            this.ui.creditLabel = creditLabel;

            // Current Card Display Area
            const currentCardContainer = panel.CreateVisualElement(rootEl);
            await currentCardContainer.Async();
            currentCardContainer.SetStyles({
                display: 'none',
                width: '500px',
                height: '320px',
                backgroundColor: 'rgba(0, 0, 0, 0.9)',
                padding: '25px',
                borderRadius: '20px',
                borderWidth: '22px',
                borderColor: 'rgba(0, 0, 0, 1)',
                marginBottom: '20px',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundImage: 'none'
            });

            const currentCardLabel = panel.CreateLabel(undefined, currentCardContainer);
            await currentCardLabel.Async();
            currentCardLabel.SetStyles({
                backgroundColor: 'rgba(0, 0, 0, 0)',
                width: '100%',
                height: '100%',
                color: 'black',
                fontSize: '58px',
                fontWeight: 'bold',
                textAlign: 'center'
            });

            this.ui.currentCard = { container: currentCardContainer, label: currentCardLabel };

            // Winner Announcement Label
            const winnerLabel = panel.CreateLabel(undefined, rootEl);
            await winnerLabel.Async();
            winnerLabel.text = "";
            winnerLabel.SetStyles({
                display: 'none',
                backgroundColor: 'rgba(0, 0, 0, 0)',
                color: '#ffcc00',
                fontSize: '48px',
                fontWeight: 'bold',
                marginBottom: '20px',
                paddingTop: '10px',
                paddingBottom: '10px',
                paddingLeft: '30px',
                paddingRight: '30px',
                borderRadius: '50px',
                backgroundImage: 'none'
            });
            this.ui.winnerLabel = winnerLabel;

            // House Rules Settings Panel (host-only, pre-game)
            this.ui.settingsBtn = await createBtn(buttonsRow, "⚙ RULES", "#795548", () => {
                this.settingsPanelOpen = !this.settingsPanelOpen;
                this.sync();
            });

            const settingsContainer = panel.CreateVisualElement(rootEl);
            await settingsContainer.Async();
            settingsContainer.SetStyles({
                display: 'none',
                flexDirection: 'column',
                alignItems: 'center',
                backgroundColor: 'rgba(30, 30, 30, 0.95)',
                paddingTop: '20px',
                paddingBottom: '20px',
                paddingLeft: '25px',
                paddingRight: '25px',
                borderRadius: '15px',
                borderWidth: '2px',
                borderColor: '#795548',
                marginBottom: '15px',
                width: '820px',
                backgroundImage: 'none'
            });

            const settingsTitle = panel.CreateLabel(undefined, settingsContainer);
            await settingsTitle.Async();
            settingsTitle.text = "HOUSE RULES";
            settingsTitle.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', color: '#FFAB40', fontSize: '28px', fontWeight: 'bold', marginBottom: '15px' });

            // Helper to create a toggle row
            const createToggleRow = async (parent, label, ruleKey, defaultValue) => {
                const row = panel.CreateVisualElement(parent);
                await row.Async();
                row.SetStyles({
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '10px',
                    backgroundColor: 'rgba(0,0,0,0)',
                    width: '100%',
                    paddingLeft: '10px',
                    paddingRight: '10px'
                });

                const lbl = panel.CreateLabel(undefined, row);
                await lbl.Async();
                lbl.text = label;
                lbl.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', color: 'white', fontSize: '22px', width: '500px' });

                const btn = panel.CreateButton(row);
                await btn.Async();
                btn.text = defaultValue ? "ON" : "OFF";
                btn.SetStyles({
                    backgroundColor: defaultValue ? '#4CAF50' : '#F44336',
                    color: 'white',
                    paddingTop: '10px',
                    paddingBottom: '10px',
                    paddingLeft: '30px',
                    paddingRight: '30px',
                    borderRadius: '8px',
                    fontSize: '22px',
                    borderWidth: '0px',
                    backgroundImage: 'none',
                    width: '120px'
                });

                btn.OnClick(() => {
                    const currentRules = (this.gameState && this.gameState.houseRules) || this.getDefaultState().houseRules;
                    const currentValue = currentRules[ruleKey] !== undefined ? !!currentRules[ruleKey] : defaultValue;
                    const newValue = !currentValue;
                    this.sendAction("set-house-rules", { houseRules: { [ruleKey]: newValue } });
                });

                return { row, label: lbl, btn, ruleKey, defaultValue };
            };

            const toggleStacking = await createToggleRow(settingsContainer, "Draw Stacking (+2/+4)", "stacking", true);
            const togglePlayAny = await createToggleRow(settingsContainer, "Play Any Card After Draw", "playAnyAfterDraw", true);
            const toggleAutoUno = await createToggleRow(settingsContainer, "Auto UNO Penalty", "autoUnoPenalty", true);
            const toggleForcePlay = await createToggleRow(settingsContainer, "Force Play (auto-play drawn card)", "forcePlay", false);
            const toggleDrawToPlay = await createToggleRow(settingsContainer, "Draw to Play (draw until playable)", "drawToPlay", false);
            const toggleSevenZero = await createToggleRow(settingsContainer, "7-0 (swap/rotate hands)", "sevenZero", false);
            const toggleJumpIn = await createToggleRow(settingsContainer, "Jump-In (play identical card anytime)", "jumpIn", false);

            this.ui.settingsPanel = {
                container: settingsContainer,
                toggles: [toggleStacking, togglePlayAny, toggleAutoUno, toggleForcePlay, toggleDrawToPlay, toggleSevenZero, toggleJumpIn]
            };

            // Active rules summary label (shown during gameplay for all players)
            const rulesLabel = panel.CreateLabel(undefined, rootEl);
            await rulesLabel.Async();
            rulesLabel.text = "";
            rulesLabel.SetStyles({
                display: 'none',
                backgroundColor: 'rgba(0,0,0,0)',
                color: '#aaaaaa',
                fontSize: '20px',
                marginBottom: '10px',
                textAlign: 'center'
            });
            this.ui.rulesLabel = rulesLabel;
        }

        confirm(message, callback, previewCards = null, confirmationType = 'default') {
            const localPlayer = this.gameState.players[scene.localUser.uid];
            if (!localPlayer) return;
            const slice = this.ui.slices[localPlayer.position];
            if (!slice) return;

            slice.confirmMsg.text = message;
            this.confirmCallback = callback;
            this.isConfirmationDialogOpen = true;
            slice.confirmOverlay.SetStyles({ 
                display: 'flex', 
                backgroundColor: 'rgba(25, 25, 25, 0.93)',
                alignItems: 'center',
                justifyContent: 'center'
            });

            // Hide all custom UI elements first
            if (slice.colorChoiceRow) slice.colorChoiceRow.SetStyles({ display: 'none' });
            if (slice.confirmButtonsRow) slice.confirmButtonsRow.SetStyles({ display: 'none' });
            if (slice.swapChoiceRow) slice.swapChoiceRow.SetStyles({ display: 'none' });

            if (confirmationType === 'choose-color') {
                if (slice.colorChoiceRow) {
                    slice.colorChoiceRow.SetStyles({ display: 'flex' });
                }
            } else if (confirmationType === 'choose-player-swap') {
                if (slice.swapChoiceRow && slice.swapPlayerBtns) {
                    // Populate the pre-created swap buttons with opponent info
                    const opponents = Object.values(this.gameState.players).filter(p => p.id !== scene.localUser.uid);
                    slice.swapPlayerBtns.forEach((btn, idx) => {
                        if (idx < opponents.length) {
                            btn.text = opponents[idx].name + ` (${opponents[idx].hand.length})`;
                            btn._swapTargetId = opponents[idx].id;
                            btn.SetStyles({ display: 'flex' });
                        } else {
                            btn.text = "";
                            btn._swapTargetId = null;
                            btn.SetStyles({ display: 'none' });
                        }
                    });
                    slice.swapChoiceRow.SetStyles({ display: 'flex' });
                }
            } else {
                if (slice.confirmButtonsRow) slice.confirmButtonsRow.SetStyles({ display: 'flex' });
            }
        }


        // Helper to get card text for Uno
        getCardText(card) {
            if (!card) return "";
            if (card.type === "wild") {
                return `WILD\n(Color: ${card.chosenColor ? card.chosenColor.toUpperCase() : '?'})`;
            }
            if (card.type === "wild_draw_4") {
                return `WILD\nDRAW 4\n(Color: ${card.chosenColor ? card.chosenColor.toUpperCase() : '?'})`;
            }
            // For regular cards, format as COLOR\nVALUE
            return `${card.color.toUpperCase()}\n${card.value.toUpperCase()}`;
        }

        // Helper to determine if local user is the host
        isHost() {
            if (!scene || !scene.localUser) return false;
            if (!this.gameState || !this.gameState.currentHostUid) {
                const uids = Object.keys(scene.users || {}).sort();
                return uids.length > 0 && uids[0] === scene.localUser.uid;
            }
            return this.gameState.currentHostUid === scene.localUser.uid;
        }

        // BanterSpace state changed handler
        onSpaceStateChanged(e) {
            // Only process if the change is relevant to our game state key
            if (e.detail.changes.some(c => c.property === this.stateKey)) { // Changed STATE_KEY to this.stateKey
                this.sync();
            }
        }

        // Handle user leaving the space
        onSpaceUserLeft(e) {
            const userId = e.detail.uid;
            if (this.gameState && this.gameState.players[userId]) {
                this.log(`User ${userId} left the space. Grace period started.`);
                // Mark as disconnected instead of immediate removal
                const player = this.gameState.players[userId];
                player.isDisconnected = true;
                player.disconnectTime = Date.now();
                
                this.updateState({ players: this.gameState.players });
            }
        }

        sync() {
            if (!scene || !scene.spaceState) {
                this.log("Scene or spaceState not available for sync.");
                return;
            }

            const newGameStateRaw = scene.spaceState.public[this.stateKey]; // Changed STATE_KEY to this.stateKey
            let newGameState;
            try {
                newGameState = newGameStateRaw ? JSON.parse(newGameStateRaw) : null;
            } catch (error) {
                this.log("Error parsing game state from space:", error);
                return;
            }

            if (!newGameState) {
                // If no state exists in space, initialize a default local state
                if (!this.gameState) {
                    this.gameState = this.getDefaultState(); // Use getDefaultState
                    this.log("Game state not found in space, initializing local default state.");
                } else {
                    // If newGameState is null but this.gameState exists, it means the state was cleared in space.
                    // Reset local state to default.
                    this.gameState = this.getDefaultState(); // Use getDefaultState
                    this.log("Game state cleared in space, resetting local state.");
                }
                this.playersInitiallyLoaded = {}; // Clear if state is reset
                this.firstSyncDone = false; // Reset flag
            } else {
                // Check for sound to play
                const oldSound = this.gameState ? this.gameState.lastSound : null;
                if (newGameState.lastSound && (!oldSound || newGameState.lastSound.ts !== oldSound.ts)) {
                    // Only play sounds triggered after we joined
                    if (newGameState.lastSound.ts > this.joinTime) {
                        this.playLocalSound(newGameState.lastSound.file);
                    }
                }

                if (JSON.stringify(this.gameState) !== JSON.stringify(newGameState)) {
                    this.gameState = newGameState;
                    this.log("Synced game state from BanterSpace:", this.gameState);

                    if (!this.firstSyncDone) { // Populate only on first successful sync
                        this.playersInitiallyLoaded = {};
                        for (const playerId in this.gameState.players) {
                            this.playersInitiallyLoaded[playerId] = this.gameState.players[playerId].isDisconnected;
                        }
                        this.firstSyncDone = true;
                    }
                }
            }
            this.updateUI();
        }

        getDefaultState() {
            return {
                players: {},
                deck: [],
                discardPile: [],
                currentPlayerId: null,
                currentCard: null,
                direction: 1,
                gameStarted: false,
                pendingDraw: 0,
                winner: null,
                awaitingColorChoice: null,
                lastPlayedWildCard: null,
                awaitingSevenSwapChoice: null, // userId of player choosing who to swap hands with (7-0 rule)
                lastAction: null,
                currentHostUid: null,
                turnStartTime: null,
                turnDuration: TURN_DURATION,
                lastSound: null,
                houseRules: {
                    stacking: true,           // Allow stacking draw_2 on draw_2, wild_draw_4 on draw cards
                    playAnyAfterDraw: true,   // Allow playing any valid card after drawing (not just the drawn card)
                    autoUnoPenalty: true,      // Automatically enforce UNO penalty (vs requiring another player to catch)
                    forcePlay: false,         // If you draw a playable card, it is played automatically
                    drawToPlay: false,        // Keep drawing until you get a playable card, then play it
                    sevenZero: false,         // 7 = swap hands with chosen player, 0 = rotate all hands
                    jumpIn: false,            // Play an identical card (same color+value) out of turn
                }
            };
        }

        // Helper to update and save game state
        async updateState(patch) {
            if (!this.gameState) return;
            Object.assign(this.gameState, patch);
            
            // If a sound was triggered during logic, sync it
            if (this.gameState._triggerSound) {
                this.gameState.lastSound = { file: this.gameState._triggerSound, ts: Date.now() };
                delete this.gameState._triggerSound;
            }

            scene.SetPublicSpaceProps({ [this.stateKey]: JSON.stringify(this.gameState) }); // Changed STATE_KEY to this.stateKey
            this.sync(); // Sync immediately after updating the space state
        }

        // Function to send actions and update BanterSpace state
        async sendAction(action, data = {}, senderUid = null) { // Added senderUid for host logic
            const localUser = scene.localUser;
            if (!localUser) {
                this.log("Local user not available. Cannot send action.");
                return;
            }

            // Ensure scene.spaceState is available before proceeding
            if (!scene.spaceState) {
                this.log("BanterSpace state is not available yet. Cannot send action.");
                return;
            }

            let currentSpaceStateRaw = scene.spaceState.public[this.stateKey];
            let currentSpaceState;
            try {
                currentSpaceState = currentSpaceStateRaw ? JSON.parse(currentSpaceStateRaw) : this.getDefaultState(); // Use getDefaultState
            } catch (error) {
                this.log("Error parsing current space state:", error);
                currentSpaceState = this.getDefaultState(); // Use getDefaultState
            }

            // Create a deep copy to modify
            let newState = JSON.parse(JSON.stringify(currentSpaceState));

            // Apply game logic based on action
            const updated = this.applyGameLogic(newState, action, senderUid || localUser.uid, localUser.name, data);

            if (updated) {
                // If the logic triggered a sound, sync it
                if (updated._triggerSound) {
                    updated.lastSound = { file: updated._triggerSound, ts: Date.now() };
                    delete updated._triggerSound;
                }
                // Only update if logic applied changes
                await scene.SetPublicSpaceProps({ [this.stateKey]: JSON.stringify(updated) });
                this.sync(); // Sync immediately after updating the space state
            }
        }

        // Placeholder for Uno game logic
        applyGameLogic(state, action, userId, userName, data) {
            // Initialize state if it's empty or if currentHostUid is missing
            if (!state || typeof state !== "object" || Object.keys(state).length === 0) {
                state = this.getDefaultState();
            } else {
                if (!state.players) state.players = {};
                if (!state.deck) state.deck = [];
                if (!state.discardPile) state.discardPile = [];
                if (state.currentHostUid === undefined) state.currentHostUid = null;
                
                const defaultState = this.getDefaultState();
                for (const key in defaultState) {
                    if (state[key] === undefined) {
                        state[key] = defaultState[key];
                    }
                }
                if (state.houseRules) {
                    for (const ruleKey in defaultState.houseRules) {
                        if (state.houseRules[ruleKey] === undefined) {
                            state.houseRules[ruleKey] = defaultState.houseRules[ruleKey];
                        }
                    }
                }
            }

            const player = state.players[userId];

            switch (action) {
                case "join-game":
                    if (!player && !state.gameStarted && Object.keys(state.players).length < MAX_PLAYERS) {
                        let availablePos = 0;
                        const usedPositions = Object.values(state.players).map(p => p.position);
                        while (usedPositions.includes(availablePos)) availablePos++;

                        state.players[userId] = {
                            id: userId,
                            name: userName,
                            hand: [],
                            score: 0,
                            position: availablePos, // Assign position
                            hasCalledUno: false,
                            hasDrawnThisTurn: false // Initialize new property
                        };
                        this.triggerSound(state, "join"); // Changed to triggerSound
                    }
                    break;
                case "leave-game":
                    if (player) {
                        this.log(`Player ${userId} is leaving the game.`);

                        // If the leaving player was awaiting a wild color choice, resolve it first
                        if (state.awaitingColorChoice === userId && state.lastPlayedWildCard) {
                            state.lastPlayedWildCard.chosenColor = "red"; // Assign default color
                            state.currentCard = state.lastPlayedWildCard;
                            this.applyCardEffect(state, state.currentCard);
                            state.awaitingColorChoice = null;
                            state.lastPlayedWildCard = null;
                        }

                        // If the leaving player was awaiting a 7-0 swap choice, cancel it
                        if (state.awaitingSevenSwapChoice === userId) {
                            state.awaitingSevenSwapChoice = null;
                        }

                        // If the leaving player was the current player, advance turn before deleting
                        if (state.currentPlayerId === userId) {
                            this.nextTurn(state, userId);
                        }
                        delete state.players[userId];
                        // Preserving seat positions by not reassigning them on leave

                        if (data.playSound !== false) { // Conditionally play sound
                            this.triggerSound(state, "leave"); // Changed to triggerSound
                        }
                        if (Object.keys(state.players).length < 2 && state.gameStarted) {
                            state.gameStarted = false; // End game if not enough players
                            state.winner = null;
                            state.currentPlayerId = null;
                            state.pendingDraw = 0;
                            state.awaitingColorChoice = null;
                            state.lastPlayedWildCard = null;
                            state.awaitingSevenSwapChoice = null;
                            state.turnStartTime = null; // No active turn, no timer
                        }
                    }
                    break;
                case "start-game":
                    // Only host can start the game
                    if (this.isHost() && (!state.gameStarted || state.winner) && Object.keys(state.players).length >= 2) {
                        state = this.initializeNewGame(state);
                        this.triggerSound(state, "start"); // Changed to triggerSound
                    }
                    break;
                case "play-card": {
                    // Helper: finalize a card play (shared between normal and jump-in paths)
                    const playCardLogic = (playingPlayer, playingUserId, cardToPlay) => {
                        playingPlayer.hand = playingPlayer.hand.filter(c => c.id !== cardToPlay.id);
                        state.discardPile.push(cardToPlay);
                        playingPlayer.hasDrawnThisTurn = false;
                        playingPlayer.lastDrawnCardId = null;
                        state.turnStartTime = Date.now();

                        if (cardToPlay.type === "wild" || cardToPlay.type === "wild_draw_4") {
                            state.awaitingColorChoice = playingUserId;
                            state.lastPlayedWildCard = cardToPlay;
                            this.triggerSound(state, "play_card");
                        } else {
                            state.currentCard = cardToPlay;
                            this.applyCardEffect(state, cardToPlay);

                            // 7-0 rule: playing a 7 triggers hand swap choice
                            if (state.houseRules && state.houseRules.sevenZero && cardToPlay.value === "7") {
                                const otherPlayers = Object.keys(state.players).filter(id => id !== playingUserId);
                                if (otherPlayers.length > 0) {
                                    // Check UNO penalty before suspending for swap choice
                                    if (playingPlayer.hand.length === 0 && (!state.houseRules || state.houseRules.autoUnoPenalty !== false)) {
                                        if (!playingPlayer.hasCalledUno) {
                                            this.log(`${playingPlayer.name} did not call UNO on winning play! Drawing 2 cards.`);
                                            this.drawCardsForPlayer(state, playingUserId, 2);
                                        }
                                        playingPlayer.hasCalledUno = false;
                                    }
                                    state.awaitingSevenSwapChoice = playingUserId;
                                    this.triggerSound(state, "play_card");
                                    return; // Suspend turn — awaiting swap choice
                                }
                            }

                            // 7-0 rule: playing a 0 triggers hand rotation
                            if (state.houseRules && state.houseRules.sevenZero && cardToPlay.value === "0") {
                                this.rotateHands(state);
                            }

                            if (playingPlayer.hand.length === 0 && (!state.houseRules || state.houseRules.autoUnoPenalty !== false)) {
                                if (!playingPlayer.hasCalledUno) {
                                    this.log(`${playingPlayer.name} did not call UNO on winning play! Drawing 2 cards.`);
                                    this.drawCardsForPlayer(state, playingUserId, 2);
                                }
                                playingPlayer.hasCalledUno = false;
                            }

                            if (playingPlayer.hand.length === 0) {
                                state.winner = playingUserId;
                                state.gameStarted = false;
                                this.triggerSound(state, "win");
                            } else {
                                this.nextTurn(state, playingUserId);
                                this.triggerSound(state, "play_card");
                            }
                        }
                    };

                    if (!player || state.winner || state.awaitingColorChoice || state.awaitingSevenSwapChoice) break;

                    const cardToPlay = player.hand.find(c => c.id === data.cardId);
                    if (!cardToPlay) break;

                    // --- Jump-In Logic ---
                    if (state.currentPlayerId !== userId) {
                        // Out-of-turn play is only allowed if jumpIn is enabled
                        if (state.houseRules && state.houseRules.jumpIn &&
                            state.currentCard &&
                            cardToPlay.color !== "black" && // Wild cards cannot be used to jump in
                            cardToPlay.color === state.currentCard.color &&
                            cardToPlay.value === state.currentCard.value &&
                            state.pendingDraw === 0) { // Cannot jump in during a pending draw stack
                            // Valid jump-in! Set this player as current and play the card
                            state.currentPlayerId = userId;
                            playCardLogic(player, userId, cardToPlay);
                        } else {
                            this.log("Jump-in not allowed or conditions not met for", userName);
                        }
                        break;
                    }

                    // --- Normal turn play ---
                    // Enforce play-after-draw restriction
                    if (player.hasDrawnThisTurn && state.houseRules && !state.houseRules.playAnyAfterDraw) {
                        if (cardToPlay.id !== player.lastDrawnCardId) {
                            this.log("Cannot play a card other than the drawn card (playAnyAfterDraw is off)");
                            break;
                        }
                    }

                    if (this.isValidPlay(cardToPlay, state.currentCard, state.pendingDraw, state.houseRules)) {
                        playCardLogic(player, userId, cardToPlay);
                    } else {
                        this.log("Invalid card play attempted by", userName);
                    }
                    break;
                }
                case "draw-card":
                    if (player && state.currentPlayerId === userId && !state.winner && !state.awaitingColorChoice && !state.awaitingSevenSwapChoice) {
                        if (state.pendingDraw > 0) {
                            this.drawCardsForPlayer(state, userId, state.pendingDraw);
                            state.pendingDraw = 0;
                            state.turnStartTime = Date.now(); // Reset timer on action
                            this.nextTurn(state, userId); // Skip this player's turn after drawing forced cards
                        } else if (state.houseRules && state.houseRules.drawToPlay) {
                            // Draw-to-Play: keep drawing until a playable card is found
                            let drawnPlayable = null;
                            let drawCount = 0;
                            const maxDraws = 108; // Safety cap to avoid infinite loops
                            while (drawCount < maxDraws) {
                                const handSizeBefore = player.hand.length;
                                this.drawCardsForPlayer(state, userId, 1);
                                if (player.hand.length <= handSizeBefore) break; // No cards left to draw
                                drawCount++;
                                const drawnCard = player.hand[player.hand.length - 1];
                                if (this.isValidPlay(drawnCard, state.currentCard, 0, state.houseRules)) {
                                    drawnPlayable = drawnCard;
                                    break;
                                }
                            }
                            state.turnStartTime = Date.now();
                            if (drawnPlayable) {
                                // Auto-play the drawn playable card
                                if (drawnPlayable.type === "wild" || drawnPlayable.type === "wild_draw_4") {
                                    // For wild cards, set up for color choice (player must choose)
                                    player.hand = player.hand.filter(c => c.id !== drawnPlayable.id);
                                    state.discardPile.push(drawnPlayable);
                                    state.awaitingColorChoice = userId;
                                    state.lastPlayedWildCard = drawnPlayable;
                                    player.hasDrawnThisTurn = false;
                                } else {
                                    player.hand = player.hand.filter(c => c.id !== drawnPlayable.id);
                                    state.discardPile.push(drawnPlayable);
                                    state.currentCard = drawnPlayable;
                                    this.applyCardEffect(state, drawnPlayable);
                                    player.hasDrawnThisTurn = false;

                                    // 7-0 rule checks on auto-played card
                                    if (state.houseRules.sevenZero && drawnPlayable.value === "7") {
                                        const otherPlayers = Object.keys(state.players).filter(id => id !== userId);
                                        if (otherPlayers.length > 0) {
                                            state.awaitingSevenSwapChoice = userId;
                                            this.triggerSound(state, "play_card");
                                            break; // Suspend for swap choice
                                        }
                                    }
                                    if (state.houseRules.sevenZero && drawnPlayable.value === "0") {
                                        this.rotateHands(state);
                                    }

                                    if (player.hand.length === 0) {
                                        state.winner = userId;
                                        state.gameStarted = false;
                                        this.triggerSound(state, "win");
                                    } else {
                                        this.nextTurn(state, userId);
                                    }
                                }
                                this.triggerSound(state, "play_card");
                            } else {
                                // Drew all cards but none were playable — pass turn
                                player.hasDrawnThisTurn = false;
                                this.nextTurn(state, userId);
                            }
                        } else if (state.houseRules && state.houseRules.forcePlay) {
                            // Force Play: draw 1 card, auto-play if playable
                            const handSizeBefore = player.hand.length;
                            this.drawCardsForPlayer(state, userId, 1);
                            state.turnStartTime = Date.now();
                            if (player.hand.length > handSizeBefore) {
                                const drawnCard = player.hand[player.hand.length - 1];
                                if (this.isValidPlay(drawnCard, state.currentCard, 0, state.houseRules)) {
                                    // Auto-play the drawn card
                                    if (drawnCard.type === "wild" || drawnCard.type === "wild_draw_4") {
                                        player.hand = player.hand.filter(c => c.id !== drawnCard.id);
                                        state.discardPile.push(drawnCard);
                                        state.awaitingColorChoice = userId;
                                        state.lastPlayedWildCard = drawnCard;
                                        player.hasDrawnThisTurn = false;
                                    } else {
                                        player.hand = player.hand.filter(c => c.id !== drawnCard.id);
                                        state.discardPile.push(drawnCard);
                                        state.currentCard = drawnCard;
                                        this.applyCardEffect(state, drawnCard);
                                        player.hasDrawnThisTurn = false;

                                        // 7-0 rule checks on auto-played card
                                        if (state.houseRules.sevenZero && drawnCard.value === "7") {
                                            const otherPlayers = Object.keys(state.players).filter(id => id !== userId);
                                            if (otherPlayers.length > 0) {
                                                state.awaitingSevenSwapChoice = userId;
                                                this.triggerSound(state, "play_card");
                                                break; // Suspend for swap choice
                                            }
                                        }
                                        if (state.houseRules.sevenZero && drawnCard.value === "0") {
                                            this.rotateHands(state);
                                        }

                                        if (player.hand.length === 0) {
                                            state.winner = userId;
                                            state.gameStarted = false;
                                            this.triggerSound(state, "win");
                                        } else {
                                            this.nextTurn(state, userId);
                                        }
                                    }
                                    this.triggerSound(state, "play_card");
                                } else {
                                    // Drawn card is not playable — normal draw behavior
                                    player.lastDrawnCardId = drawnCard.id;
                                    player.hasDrawnThisTurn = true;
                                }
                            }
                        } else {
                            // Default: draw 1 card, allow play or pass
                            const handSizeBefore = player.hand.length;
                            this.drawCardsForPlayer(state, userId, 1);
                            if (player.hand.length > handSizeBefore) {
                                player.lastDrawnCardId = player.hand[player.hand.length - 1].id;
                            }
                            state.turnStartTime = Date.now(); // Reset timer on action
                            player.hasDrawnThisTurn = true; // Player has drawn a card this turn
                        }
                        this.triggerSound(state, "draw_card");
                        // Do not call nextTurn here if only 1 card drawn, player can still play or pass
                    }
                    break;
                case "pass-turn":
                    if (player && state.currentPlayerId === userId && !state.winner && !state.awaitingColorChoice && player.hasDrawnThisTurn) {
                        player.hasDrawnThisTurn = false; // Reset for next turn
                        state.turnStartTime = Date.now(); // Reset timer on action
                        this.nextTurn(state, userId);
                        this.triggerSound(state, "pass"); // Changed to triggerSound
                    } else {
                        this.log("Invalid pass-turn action by", userName);
                    }
                    break;
                case "call-uno":
                    // UNO can be called at 2 cards (before playing second-to-last) or 1 card (after playing).
                    // This is intentional: players need to call UNO before or as they play their second-to-last card.
                    if (player && (player.hand.length === 1 || player.hand.length === 2)) {
                        player.hasCalledUno = true;
                        this.triggerSound(state, "uno"); // Changed to triggerSound
                    }
                    break;
                case "choose-wild-color":
                    const validColors = ["red", "green", "blue", "yellow"];
                    if (state.awaitingColorChoice === userId && state.lastPlayedWildCard && data.chosenColor && validColors.includes(data.chosenColor)) {
                        state.lastPlayedWildCard.chosenColor = data.chosenColor;
                        state.currentCard = state.lastPlayedWildCard;
                        this.applyCardEffect(state, state.currentCard);
                        state.turnStartTime = Date.now(); // Reset timer on action

                        if (player.hand.length === 0 && (!state.houseRules || state.houseRules.autoUnoPenalty !== false)) {
                            // Check UNO penalty before declaring winner (player went 1→0 without calling UNO)
                            if (!player.hasCalledUno) {
                                this.log(`${player.name} did not call UNO on winning play! Drawing 2 cards.`);
                                this.drawCardsForPlayer(state, userId, 2);
                            }
                            player.hasCalledUno = false;
                        }

                        if (player.hand.length === 0) {
                            state.winner = userId;
                            state.gameStarted = false;
                            this.triggerSound(state, "win"); // Changed to triggerSound
                        } else {
                            this.nextTurn(state, userId);
                            this.triggerSound(state, "play_card"); // Changed to triggerSound
                        }

                        state.awaitingColorChoice = null;
                        state.lastPlayedWildCard = null;
                    } else {
                        this.log("Invalid choose-wild-color action by", userName);
                    }
                    break;
                case "choose-seven-swap":
                    // 7-0 rule: player who played a 7 chooses who to swap hands with
                    if (state.awaitingSevenSwapChoice === userId && data.targetPlayerId && state.players[data.targetPlayerId]) {
                        const swapTarget = state.players[data.targetPlayerId];
                        const tempHand = [...player.hand];
                        player.hand = [...swapTarget.hand];
                        swapTarget.hand = tempHand;
                        // Reset UNO flags for both players since their hand sizes changed
                        player.hasCalledUno = false;
                        swapTarget.hasCalledUno = false;
                        state.awaitingSevenSwapChoice = null;
                        state.turnStartTime = Date.now();

                        // Check for win after swap (player may now have 0 cards)
                        if (player.hand.length === 0) {
                            state.winner = userId;
                            state.gameStarted = false;
                            this.triggerSound(state, "win");
                        } else {
                            this.nextTurn(state, userId);
                            this.triggerSound(state, "play_card");
                        }
                    } else {
                        this.log("Invalid choose-seven-swap action by", userName);
                    }
                    break;
                case "set-house-rules":
                    // Only host can change house rules, and only before game starts
                    if (state.currentHostUid === userId && !state.gameStarted && data.houseRules) {
                        const allowedKeys = ["stacking", "playAnyAfterDraw", "autoUnoPenalty", "forcePlay", "drawToPlay", "sevenZero", "jumpIn"];
                        if (!state.houseRules) {
                            state.houseRules = { stacking: true, playAnyAfterDraw: true, autoUnoPenalty: true, forcePlay: false, drawToPlay: false, sevenZero: false, jumpIn: false };
                        }
                        for (const key of allowedKeys) {
                            if (typeof data.houseRules[key] === "boolean") {
                                state.houseRules[key] = data.houseRules[key];
                            }
                        }
                    }
                    break;
                case "timeout-player":
                    const timedOutPlayerId = data.timedOutPlayerId;
                    if (state.players[timedOutPlayerId]) {
                        this.log(`Player ${timedOutPlayerId} timed out and is being removed.`);

                        // If the timed out player was awaiting a wild color choice, resolve it first
                        if (state.awaitingColorChoice === timedOutPlayerId && state.lastPlayedWildCard) {
                            state.lastPlayedWildCard.chosenColor = "red"; // Assign default color
                            state.currentCard = state.lastPlayedWildCard;
                            this.applyCardEffect(state, state.currentCard);
                            state.awaitingColorChoice = null;
                            state.lastPlayedWildCard = null;
                        }

                        // If the timed out player was awaiting a 7-0 swap choice, cancel it
                        if (state.awaitingSevenSwapChoice === timedOutPlayerId) {
                            state.awaitingSevenSwapChoice = null;
                        }

                        // If the timed out player was the current player, advance turn before deleting
                        if (state.currentPlayerId === timedOutPlayerId) {
                            state.pendingDraw = 0;
                            this.nextTurn(state, timedOutPlayerId);
                        }
                        delete state.players[timedOutPlayerId];
                        // Preserving seat positions by not reassigning them on timeout

                        // If the timed out player was the host, reassign host
                        if (state.currentHostUid === timedOutPlayerId) {
                            state.currentHostUid = null; // driveHostLogic will reassign
                        }

                        // If not enough players to continue game
                        if (Object.keys(state.players).length < 2 && state.gameStarted) {
                            state.gameStarted = false;
                            state.winner = null;
                            state.currentPlayerId = null;
                            state.pendingDraw = 0;
                            state.awaitingColorChoice = null;
                            state.lastPlayedWildCard = null;
                            state.awaitingSevenSwapChoice = null;
                            state.turnStartTime = null; // No active turn, no timer
                        }
                        if (data.playSound !== false) { // Only play sound if explicitly not false
                            this.triggerSound(state, "leave"); // Changed to triggerSound
                        }
                    }
                    break;
            }

            state.lastAction = { action, userId, data, timestamp: Date.now() };
            return state;
        }

        // Uno Game Logic Helpers
        initializeNewGame(state) {
            // Preserve house rules across games — they persist from pre-game configuration
            const existingRules = state.houseRules;

            state.deck = this.createUnoDeck();
            this.shuffleDeck(state.deck);
            state.discardPile = [];
            state.gameStarted = true;
            state.winner = null;
            state.pendingDraw = 0;
            state.direction = 1;
            state.awaitingColorChoice = null;
            state.lastPlayedWildCard = null;
            state.awaitingSevenSwapChoice = null;
            state.turnStartTime = null; // Reset turnStartTime
            state.turnDuration = TURN_DURATION; // Set turnDuration
            state.houseRules = existingRules || { stacking: true, playAnyAfterDraw: true, autoUnoPenalty: true, forcePlay: false, drawToPlay: false, sevenZero: false, jumpIn: false };

            const playerIds = Object.keys(state.players);
            playerIds.forEach(id => {
                state.players[id].hand = [];
                state.players[id].hasCalledUno = false;
                state.players[id].hasDrawnThisTurn = false; // Initialize for new game
                state.players[id].lastDrawnCardId = null; // Reset drawn card tracking
                this.drawCardsForPlayer(state, id, 7); // Deal 7 cards
            });

            // Start with a non-action card on the discard pile
            // Safeguard: limit attempts to prevent theoretical infinite loop
            let firstCard;
            let attempts = 0;
            do {
                firstCard = state.deck.shift();
                if (firstCard.type === "action" || firstCard.type === "wild" || firstCard.type === "wild_draw_4") {
                    state.deck.push(firstCard); // Put action cards back and reshuffle
                    this.shuffleDeck(state.deck);
                }
                attempts++;
            } while ((firstCard.type === "action" || firstCard.type === "wild" || firstCard.type === "wild_draw_4") && attempts < 108);

            state.currentCard = firstCard;
            state.discardPile.push(firstCard);

            state.currentPlayerId = playerIds[0]; // First player starts
            state.turnStartTime = Date.now(); // Start timer for the first player
            return state;
        }

        createUnoDeck() {
            const colors = ["red", "green", "blue", "yellow"];
            const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw_2"];
            let deck = [];
            let cardIdCounter = 0;

            colors.forEach(color => {
                deck.push({ id: cardIdCounter++, color, value: "0", type: "number" }); // One '0' of each color
                for (let i = 0; i < 2; i++) { // Two of each 1-9, skip, reverse, draw_2
                    values.slice(1).forEach(value => {
                        deck.push({ id: cardIdCounter++, color, value, type: value.includes("draw") || value.includes("skip") || value.includes("reverse") ? "action" : "number" });
                    });
                }
            });

            for (let i = 0; i < 4; i++) { // Four Wild cards
                deck.push({ id: cardIdCounter++, color: "black", value: "wild", type: "wild" });
                deck.push({ id: cardIdCounter++, color: "black", value: "wild_draw_4", type: "wild_draw_4" });
            }
            return deck;
        }

        shuffleDeck(deck) {
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }
        }

        drawCardsForPlayer(state, playerId, count) {
            const player = state.players[playerId];
            if (!player) return;

            for (let i = 0; i < count; i++) {
                if (state.deck.length === 0) {
                    // Reshuffle discard pile into deck, keeping top card
                    const currentTopCard = state.discardPile.pop();
                    state.deck = state.discardPile;
                    // Clear chosen colors of wild cards being reshuffled
                    state.deck.forEach(card => {
                        if (card.type === "wild" || card.type === "wild_draw_4") {
                            delete card.chosenColor;
                        }
                    });
                    this.shuffleDeck(state.deck);
                    state.discardPile = [currentTopCard];
                    if (state.deck.length === 0) {
                        this.log("No more cards to draw!");
                        break; // No cards left to draw
                    }
                }
                player.hand.push(state.deck.shift());
            }
        }

        isValidPlay(cardToPlay, currentCard, pendingDraw, houseRules) {
            if (!cardToPlay || !currentCard) return false;

            // If there's a pending draw, check stacking rules
            if (pendingDraw > 0) {
                // If stacking is disabled, no cards can be played — player must draw
                if (houseRules && houseRules.stacking === false) {
                    return false;
                }
                // Stacking rules (official house rule):
                // - A Draw 2 can only be stacked on another Draw 2 (color doesn't matter)
                if (currentCard.value === "draw_2") {
                    return cardToPlay.value === "draw_2";
                }
                // - A Wild Draw 4 can only stack on another Wild Draw 4
                if (currentCard.value === "wild_draw_4") {
                    return cardToPlay.value === "wild_draw_4";
                }
                return false;
            }

            // Wild cards can always be played
            if (cardToPlay.type === "wild" || cardToPlay.type === "wild_draw_4") {
                return true;
            }

            // If the current card is a wild card with a chosen color, match that color
            if ((currentCard.type === "wild" || currentCard.type === "wild_draw_4") && currentCard.chosenColor) {
                return cardToPlay.color === currentCard.chosenColor;
            }

            // Match color or value
            return cardToPlay.color === currentCard.color || cardToPlay.value === currentCard.value;
        }

        applyCardEffect(state, playedCard) {
            switch (playedCard.value) {
                case "skip":
                    this.skipNextPlayer(state);
                    break;
                case "reverse":
                    state.direction *= -1;
                    // If only 2 players, reverse acts as skip
                    if (Object.keys(state.players).length === 2) {
                        this.skipNextPlayer(state);
                    }
                    break;
                case "draw_2":
                    state.pendingDraw += 2;
                    // Removed this.skipNextPlayer(state); - nextTurn will handle the skip after draw
                    break;
                case "wild_draw_4":
                    state.pendingDraw += 4;
                    // Removed this.skipNextPlayer(state); - nextTurn will handle the skip after draw
                    // Color is chosen by player, already set in playedCard.chosenColor
                    break;
                case "wild":
                    // Color is chosen by player, already set in playedCard.chosenColor
                    break;
            }
        }

        skipNextPlayer(state) {
            const playerIds = Object.values(state.players)
                .sort((a, b) => a.position - b.position)
                .map(p => p.id);
            if (playerIds.length === 0) return;

            const currentIndex = playerIds.indexOf(state.currentPlayerId);
            let nextIndex = currentIndex + state.direction;

            if (nextIndex >= playerIds.length) {
                nextIndex = 0;
            } else if (nextIndex < 0) {
                nextIndex = playerIds.length - 1;
            }
            state.currentPlayerId = playerIds[nextIndex]; // Set to the skipped player
            // Reset hasDrawnThisTurn for the skipped player
            if (state.players[state.currentPlayerId]) {
                state.players[state.currentPlayerId].hasDrawnThisTurn = false;
            }
        }

        nextTurn(state, actualPreviousPlayerId) {
            const playerIds = Object.values(state.players)
                .sort((a, b) => a.position - b.position)
                .map(p => p.id);
            if (playerIds.length === 0) {
                state.currentPlayerId = null;
                state.turnStartTime = null; // No current player, no timer
                return;
            }

            // Use the explicitly passed previous player ID if provided (handles skip/reverse correctly),
            // otherwise fall back to state.currentPlayerId for backward compatibility.
            const previousPlayerId = actualPreviousPlayerId || state.currentPlayerId;
            const previousPlayer = state.players[previousPlayerId];

            let currentIndex = playerIds.indexOf(state.currentPlayerId);

            // If current player is not found or null, start with the first player
            if (currentIndex === -1) {
                state.currentPlayerId = playerIds[0];
                if (state.players[state.currentPlayerId]) {
                    state.players[state.currentPlayerId].hasDrawnThisTurn = false;
                }
                state.turnStartTime = Date.now(); // Start timer for the new current player
                return; // Turn set to first player, no further advancement needed for this call
            }

            let nextIndex = currentIndex + state.direction;
            if (nextIndex >= playerIds.length) {
                nextIndex = 0;
            } else if (nextIndex < 0) {
                nextIndex = playerIds.length - 1;
            }
            state.currentPlayerId = playerIds[nextIndex];

            // Apply Uno penalty to previous player if applicable (respects autoUnoPenalty house rule)
            if (!state.houseRules || state.houseRules.autoUnoPenalty !== false) {
                if (previousPlayer && previousPlayer.hand.length === 1 && !previousPlayer.hasCalledUno) {
                    this.log(`${previousPlayer.name} did not call UNO! Drawing 2 cards.`);
                    this.drawCardsForPlayer(state, previousPlayerId, 2);
                }
            }
            // Reset hasCalledUno for the previous player after checking
            if (previousPlayer) {
                previousPlayer.hasCalledUno = false;
            }

            // Reset hasDrawnThisTurn for the new current player
            if (state.players[state.currentPlayerId]) {
                state.players[state.currentPlayerId].hasDrawnThisTurn = false;
            }
            state.turnStartTime = Date.now(); // Start timer for the new current player
        }

        triggerSound(state, name) {
            state._triggerSound = name;
        }

        rotateHands(state) {
            // 7-0 rule: rotate all hands in the current direction of play
            const playerIds = Object.values(state.players)
                .sort((a, b) => a.position - b.position)
                .map(p => p.id);
            if (playerIds.length < 2) return;

            const hands = playerIds.map(id => [...state.players[id].hand]);

            for (let i = 0; i < playerIds.length; i++) {
                // Each player receives the hand of the player before them in play direction
                let sourceIndex = i - state.direction;
                if (sourceIndex < 0) sourceIndex = playerIds.length - 1;
                if (sourceIndex >= playerIds.length) sourceIndex = 0;
                state.players[playerIds[i]].hand = hands[sourceIndex];
                // Reset UNO flags since hand sizes changed
                state.players[playerIds[i]].hasCalledUno = false;
            }
        }

        onCardClick(index) {
            if (!this.gameState || this.isConfirmationDialogOpen) return;
            const localPlayer = this.gameState.players[scene.localUser.uid];
            if (!localPlayer || !localPlayer.hand) return;
            const card = localPlayer.hand[index];
            if (!card) return;

            // In Uno, typically only one card is selected to play
            if (this.selectedCardIds.includes(card.id)) {
                this.selectedCardIds = []; // Deselect if already selected
            } else {
                this.selectedCardIds = [card.id]; // Select this card
            }
            this.updateUI();
        }

        updateUI() {
            if (!this.gameState || !this.gameState.players || !scene.localUser) return;
            const players = this.gameState.players;
            const localUid = scene.localUser.uid;
            const isPlaying = !!players[localUid];
            const localPlayer = players[localUid];
            const isMyTurn = this.gameState.currentPlayerId === localUid;
            const userIsHost = this.isHost(); // Get host status

            // Update Central Hub
            this.ui.joinBtn.SetStyles({ display: isPlaying ? 'none' : 'flex' });
            this.ui.leaveBtn.SetStyles({ display: isPlaying ? 'flex' : 'none' });
            this.ui.creditLabel.SetStyles({ display: isPlaying ? 'none' : 'flex' });
            this.ui.claimHostBtn.SetStyles({ display: userIsHost ? 'none' : 'flex' }); // Show claim host button if not host

            const numPlayers = Object.keys(players).length;
            const minPlayers = 2; // Uno needs at least 2 players

            if (!this.gameState.gameStarted) {
                if (numPlayers < minPlayers) {
                    this.ui.statusLabel.text = `Waiting for players... (${numPlayers}/${minPlayers} joined) ${MAX_PLAYERS} Max`;
                    this.ui.statusLabel.SetStyles({ display: 'flex' });
                    this.ui.dealBtn.SetStyles({ display: 'none' });
                } else {
                    this.ui.statusLabel.SetStyles({ display: 'none' });
                    // Only host can start the game
                    this.ui.dealBtn.SetStyles({ display: userIsHost ? 'flex' : 'none' });
                }
            } else {
                this.ui.statusLabel.SetStyles({ display: 'none' });
                this.ui.dealBtn.SetStyles({ display: 'none' });
            }

            // Current Card Display
            if (this.gameState.gameStarted && this.gameState.currentCard) {
                this.ui.currentCard.label.text = this.getCardText(this.gameState.currentCard);
                this.ui.currentCard.container.SetStyles({
                    display: 'flex',
                    backgroundColor: this.getCardColor(this.gameState.currentCard)
                });
            } else {
                this.ui.currentCard.container.SetStyles({ display: 'none' });
            }

            // Winner Display
            if (this.gameState.winner) {
                const winnerPlayer = players[this.gameState.winner];
                this.ui.winnerLabel.text = `WINNER: ${winnerPlayer?.name || "???"}`;
                this.ui.winnerLabel.SetStyles({ display: 'flex' });
            } else {
                this.ui.winnerLabel.SetStyles({ display: 'none' });
            }

            // House Rules Settings Panel
            const showSettingsBtn = userIsHost && !this.gameState.gameStarted;
            this.ui.settingsBtn.SetStyles({ display: showSettingsBtn ? 'flex' : 'none' });

            if (this.ui.settingsPanel) {
                const showSettings = showSettingsBtn && this.settingsPanelOpen;
                this.ui.settingsPanel.container.SetStyles({ display: showSettings ? 'flex' : 'none' });

                // Update toggle button states to reflect current house rules
                if (showSettings && this.gameState.houseRules) {
                    const rules = this.gameState.houseRules;
                    this.ui.settingsPanel.toggles.forEach(toggle => {
                        const isOn = rules[toggle.ruleKey] !== undefined ? !!rules[toggle.ruleKey] : toggle.defaultValue;
                        toggle.btn.text = isOn ? "ON" : "OFF";
                        toggle.btn.SetStyles({
                            backgroundColor: isOn ? '#4CAF50' : '#F44336'
                        });
                    });
                }
            }

            // Rules summary label — show active rules during gameplay for all players
            if (this.ui.rulesLabel && this.gameState.houseRules) {
                const rules = this.gameState.houseRules;
                const ruleTexts = [];
                if (rules.stacking === false) ruleTexts.push("No Stacking");
                if (rules.playAnyAfterDraw === false) ruleTexts.push("Draw-Only Play");
                if (rules.autoUnoPenalty === false) ruleTexts.push("No Auto UNO Penalty");
                if (rules.forcePlay) ruleTexts.push("Force Play");
                if (rules.drawToPlay) ruleTexts.push("Draw to Play");
                if (rules.sevenZero) ruleTexts.push("7-0");
                if (rules.jumpIn) ruleTexts.push("Jump-In");

                if (ruleTexts.length > 0 && this.gameState.gameStarted) {
                    this.ui.rulesLabel.text = "Rules: " + ruleTexts.join(" | ");
                    this.ui.rulesLabel.SetStyles({ display: 'flex' });
                } else {
                    this.ui.rulesLabel.SetStyles({ display: 'none' });
                }
            }

            // Update Slices
            for (let i = 0; i < MAX_PLAYERS; i++) {
                const slice = this.ui.slices[i];
                if (!slice) continue;
                const playerAtPos = Object.values(players).find(p => p.position === i);

                if (!playerAtPos) {
                    slice.nameText.text = "Empty Seat";
                    slice.statusText.text = "";
                    slice.timerText.text = "";
                    slice.sRoot.SetStyles({ display: 'none' });
                    slice.hRoot.SetStyles({ display: 'none' });
                    if (slice.wedgeMat) slice.wedgeMat.color = new BS.Vector4(0.15, 0.15, 0.15, 1);
                    continue;
                }

                slice.sRoot.SetStyles({ display: 'flex', backgroundColor: 'rgba(20, 20, 20, 0.93)' });
                slice.nameText.text = playerAtPos.name + ` (${(playerAtPos.hand || []).length} cards)`;

                // Timer display is handled by updateTimerDisplay()
                // slice.timerText.text = "";

                const isLocalUser = playerAtPos.id === localUid;
                const isCurrentPlayer = this.gameState.currentPlayerId === playerAtPos.id;

                if (isCurrentPlayer) {
                    slice.wedgeMat.color = new BS.Vector4(0.2, 0.6, 1.0, 1); // Vibrant Blue for current player
                } else if (isLocalUser) {
                    slice.wedgeMat.color = new BS.Vector4(0.4, 1.0, 0.4, 1); // Vibrant Green for Local
                } else {
                    slice.wedgeMat.color = new BS.Vector4(0.3, 0.3, 0.3, 1); // Lighter Grey for Others
                }

                if (isLocalUser) {
                    // Always show the hand UI for the local player so they can see confirmation dialogs
                    slice.hRoot.SetStyles({ display: 'flex' });

                    const isGameActive = this.gameState.gameStarted && !this.gameState.winner;

                    if (isGameActive) {
                        slice.statusText.text = isMyTurn ? "YOUR TURN" : "WAITING";

                        // If it's my turn and I just played a wild card, open color choice dialog
                        if (this.gameState.awaitingColorChoice === localUid && this.gameState.lastPlayedWildCard) {
                            if (!this.isConfirmationDialogOpen) { // Prevent opening multiple times
                                this.confirm("Choose a color for your Wild card:", (chosenColor) => {
                                    this.sendAction("choose-wild-color", { chosenColor });
                                }, null, 'choose-color');
                            }
                        } else if (this.gameState.awaitingSevenSwapChoice === localUid) {
                            // 7-0 rule: player must choose who to swap hands with
                            if (!this.isConfirmationDialogOpen) {
                                this.confirm("Choose a player to swap hands with:", (targetPlayerId) => {
                                    this.sendAction("choose-seven-swap", { targetPlayerId });
                                }, null, 'choose-player-swap');
                            }
                        } else {
                            // Normal hand display logic
                            slice.selectionLabel.text = this.selectedCardIds.length > 0 ? "Card Selected" : "";

                            let selectedCard = null;
                            if (this.selectedCardIds.length > 0) {
                                selectedCard = localPlayer.hand.find(c => c.id === this.selectedCardIds[0]);
                            }
                            let canPlaySelectedCard = selectedCard && this.isValidPlay(selectedCard, this.gameState.currentCard, this.gameState.pendingDraw, this.gameState.houseRules);

                            // Enforce play-after-draw restriction on UI
                            if (canPlaySelectedCard && localPlayer.hasDrawnThisTurn && this.gameState.houseRules && !this.gameState.houseRules.playAnyAfterDraw) {
                                if (selectedCard.id !== localPlayer.lastDrawnCardId) {
                                    canPlaySelectedCard = false;
                                }
                            }

                            // First, hide all card UI elements
                            slice.cardUIs.forEach(cardUI => {
                                cardUI.container.SetStyles({ display: 'none' });
                            });

                            localPlayer.hand.forEach((card, idx) => {
                                const cardUI = slice.cardUIs[idx];
                                if (cardUI && card) {
                                    const isSelected = this.selectedCardIds.includes(card.id);
                                    let isValid = this.isValidPlay(card, this.gameState.currentCard, this.gameState.pendingDraw, this.gameState.houseRules);

                                    // If playAnyAfterDraw is disabled and player has drawn, only the drawn card is playable
                                    if (localPlayer.hasDrawnThisTurn && this.gameState.houseRules && !this.gameState.houseRules.playAnyAfterDraw) {
                                        if (card.id !== localPlayer.lastDrawnCardId) {
                                            isValid = false;
                                        }
                                    }

                                    cardUI.label.text = this.getCardText(card);
                                    cardUI.container.SetStyles({
                                        display: 'flex',
                                        borderColor: isSelected ? '#4CAF50' : this.getCardColor(card),
                                        borderWidth: isSelected ? '6px' : '3px',
                                        opacity: isValid ? (isSelected ? '0.8' : '1') : '0.4', // Dim if not valid
                                        backgroundColor: this.getCardColor(card)
                                    });
                                }
                            });

                            // Jump-In: show play button for matching cards even when not your turn
                            const jumpInEnabled = this.gameState.houseRules && this.gameState.houseRules.jumpIn;
                            let canJumpIn = false;
                            if (jumpInEnabled && !isMyTurn && selectedCard && this.gameState.currentCard &&
                                selectedCard.color !== "black" &&
                                selectedCard.color === this.gameState.currentCard.color &&
                                selectedCard.value === this.gameState.currentCard.value &&
                                this.gameState.pendingDraw === 0 &&
                                !this.gameState.awaitingColorChoice &&
                                !this.gameState.awaitingSevenSwapChoice) {
                                canJumpIn = true;
                            }

                            slice.playBtn.SetStyles({ display: (isMyTurn && canPlaySelectedCard) || canJumpIn ? 'flex' : 'none' });
                            if (canJumpIn) {
                                slice.playBtn.text = "JUMP IN!";
                            } else {
                                slice.playBtn.text = "PLAY CARD";
                            }
                            slice.drawBtn.SetStyles({ display: isMyTurn && this.selectedCardIds.length === 0 && !localPlayer.hasDrawnThisTurn ? 'flex' : 'none' });
                            slice.passBtn.SetStyles({ display: isMyTurn && localPlayer.hasDrawnThisTurn ? 'flex' : 'none' });
                            // Show UNO button at 2 cards (before playing second-to-last) or 1 card (after playing). This is intentional design.
                            slice.unoBtn.SetStyles({ display: (localPlayer.hand.length === 1 || localPlayer.hand.length === 2) && !localPlayer.hasCalledUno ? 'flex' : 'none' });

                            const currentPlayer = players[this.gameState.currentPlayerId];
                            const currentPlayerName = currentPlayer ? currentPlayer.name : "Unknown";
                            slice.turnIndicatorBtn.text = `${currentPlayerName.toUpperCase()}'S TURN`;
                            slice.turnIndicatorBtn.SetStyles({ display: isMyTurn ? 'none' : 'flex' });
                        }
                    } else {
                        // Game not active (waiting to start or game ended)
                        slice.statusText.text = "";

                        // Hide game-specific buttons and labels
                        slice.playBtn.SetStyles({ display: 'none' });
                        slice.drawBtn.SetStyles({ display: 'none' });
                        slice.passBtn.SetStyles({ display: 'none' });
                        slice.unoBtn.SetStyles({ display: 'none' });
                        slice.turnIndicatorBtn.SetStyles({ display: 'none' });
                        slice.selectionLabel.text = "";

                        // Hide cards
                        slice.cardUIs.forEach(cardUI => {
                            cardUI.container.SetStyles({ display: 'none' });
                        });
                    }
                } else {
                    slice.hRoot.SetStyles({ display: 'none' });
                    let status = isCurrentPlayer ? "PLAYING" : "WAITING";
                    if (playerAtPos.isDisconnected) status = "DISCONNECTED";
                    slice.statusText.text = status;
                }
            }

            // Centralized UI hiding for confirmation dialog
            // Only hide if a confirmation dialog is open AND the condition for it to be open is no longer met
            if (this.isConfirmationDialogOpen) {
                // If there's no local player, or no awaiting state matches, hide the dialog
                const awaitingColor = this.gameState.awaitingColorChoice === localUid;
                const awaitingSwap = this.gameState.awaitingSevenSwapChoice === localUid;
                if (!localPlayer || (!awaitingColor && !awaitingSwap)) {
                    this.isConfirmationDialogOpen = false;
                    const localPlayerSlice = localPlayer ? this.ui.slices[localPlayer.position] : null;
                    if (localPlayerSlice && localPlayerSlice.confirmOverlay) {
                        localPlayerSlice.confirmOverlay.SetStyles({ display: 'none' });
                    }
                }
            }
        }

        getCardColor(card) {
            if (!card) return '#999999'; // Changed from #ffffff
            // If it's a wild card and a color has been chosen, use that color
            if ((card.type === "wild" || card.type === "wild_draw_4") && card.chosenColor) {
                switch (card.chosenColor) {
                    case 'red': return '#ff0000';
                    case 'blue': return '#00b3ff';
                    case 'green': return '#00FF00';
                    case 'yellow': return '#FFFF00';
                    default: return '#dfdfdf'; // Default for chosen color if something goes wrong
                }
            }
            // Original logic for non-wild cards or wild cards without chosen color yet
            switch (card.color) {
                case 'red': return '#FF0000';
                case 'blue': return '#00b3ff';
                case 'green': return '#00FF00';
                case 'yellow': return '#FFFF00';
                case 'black': return '#a7a7a7'; // Grey for unchosen wild cards
                default: return '#dfdfdf'; // Changed from #ffffff
            }
        }

        updateTimerDisplay() {
            if (!this.gameState || !this.gameState.players || !scene.localUser) return;
            const players = this.gameState.players;

            for (let i = 0; i < MAX_PLAYERS; i++) {
                const slice = this.ui.slices[i];
                if (!slice) continue;
                const playerAtPos = Object.values(players).find(p => p.position === i);

                if (playerAtPos && this.gameState.gameStarted && this.gameState.currentPlayerId === playerAtPos.id && this.gameState.turnStartTime) {
                    const timeLeft = Math.max(0, Math.ceil((this.gameState.turnStartTime + this.gameState.turnDuration - Date.now()) / 1000));
                    slice.timerText.text = `(${timeLeft}s)`;
                } else if (playerAtPos && playerAtPos.isDisconnected && playerAtPos.disconnectTime) {
                    const timeLeft = Math.max(0, Math.ceil((playerAtPos.disconnectTime + DISCONNECT_TIMEOUT_MS - Date.now()) / 1000));
                    slice.timerText.text = `(Disc: ${timeLeft}s)`;
                } else {
                    slice.timerText.text = "";
                }
            }
        }

        tick() { // Renamed from tickTimers
            if (!this.gameState || !this.ui.centralPanel) return;

            // Update only the timer display every second
            this.updateTimerDisplay();

            // Host logic
            if (this.isHost()) {
                this.driveHostLogic();
            }
        }

        driveHostLogic() {
            // Assign host if none is present
            if (!this.gameState.currentHostUid || !scene.users[this.gameState.currentHostUid]) {
                const allUsers = Object.keys(scene.users || {}).sort();
                if (allUsers.length > 0) {
                    const lowestUid = allUsers[0];
                    if (scene.users[lowestUid]) { // Ensure user still exists
                        this.updateState({ currentHostUid: lowestUid });
                    }
                }
            }

            const now = Date.now();
            let stateChanged = false;

            // Handle disconnected players and automatic timeouts
            for (const userId in this.gameState.players) {
                const player = this.gameState.players[userId];
                const isPresent = !!scene.users[userId];

                if (isPresent && player.isDisconnected) {
                    // Player reconnected
                    this.log(`Player ${userId} reconnected.`);
                    player.isDisconnected = false;
                    player.disconnectTime = null;
                    stateChanged = true;
                } else if (!isPresent && !player.isDisconnected) {
                    // Player just became absent, start grace period
                    this.log(`Player ${userId} detected as gone, starting grace period.`);
                    player.isDisconnected = true;
                    player.disconnectTime = now;
                    stateChanged = true;
                } else if (player.isDisconnected && player.disconnectTime && (now - player.disconnectTime >= DISCONNECT_TIMEOUT_MS)) {
                    // Player's grace period expired
                    this.log(`Player ${userId} grace period expired. Removing.`);
                    const wasInitiallyDisconnected = this.playersInitiallyLoaded.hasOwnProperty(userId) && this.playersInitiallyLoaded[userId];
                    this.applyGameLogic(this.gameState, "timeout-player", userId, player.name, { timedOutPlayerId: userId, playSound: !wasInitiallyDisconnected });
                    stateChanged = true;
                }
            }

            if (stateChanged) {
                this.updateState({ players: this.gameState.players });
            }

            // Turn timer logic
            if (this.gameState.gameStarted && this.gameState.currentPlayerId && this.gameState.turnStartTime) {
                const timeElapsed = now - this.gameState.turnStartTime;

                if (timeElapsed >= this.gameState.turnDuration) {
                    this.log(`Player ${this.gameState.currentPlayerId} timed out!`);
                    this.applyGameLogic(this.gameState, "timeout-player", this.gameState.currentPlayerId, "System", { timedOutPlayerId: this.gameState.currentPlayerId, playSound: true });
                    stateChanged = true;
                }
            }
        }
    }

    const game = new UnoGame();

    if (window.BS) {
        game.init();
    } else {
        window.addEventListener("bs-loaded", () => game.init());
    }

})();