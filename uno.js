(function () {
    let scene;
    let currentScript = document.currentScript;

    const MAX_PLAYERS = 10; // Uno typically 2-10 players
    const MAX_HAND_CARDS = 20; // Uno can have many cards in hand
    let STATE_KEY = "uno_game_state"; // Key for BanterSpace state
    const TURN_DURATION = 90 * 1000; // 900 seconds in milliseconds
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
            STATE_KEY = this.params.instance;
        }

        wrapText(text, maxChars = 19) {
            if (!text) return "";
            const words = text.replace(/\n/g, ' ').split(/\s+/).filter(word => word.length > 0);
            const lines = [];
            let currentLine = "";

            for (const word of words) {
                const testLine = currentLine.length > 0 ? currentLine + " " + word : word;
                if (testLine.length > maxChars) {
                    if (currentLine.length > 0) {
                        lines.push(currentLine.trim());
                        currentLine = word;
                    } else {
                        lines.push(word);
                        currentLine = "";
                    }
                } else {
                    currentLine = testLine;
                }
            }

            if (currentLine.trim().length > 0) {
                lines.push(currentLine.trim());
            }

            return lines.join('\n');
        }

        parseVector3(str) {
            const parts = str.split(" ").map(parseFloat);
            return new BS.Vector3(parts[0] || 0, parts[1] || 0, parts[2] || 0);
        }

        log(...args) {
            if (this.params.debug) console.log("[UNO Banter]", ...args);
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
                    fontSize: '14px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
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

            const confirmCardsRow = hPanel.CreateVisualElement(confirmOverlay);
            await confirmCardsRow.Async();
            confirmCardsRow.SetStyles({
                display: 'flex',
                flexDirection: 'row',
                marginBottom: '30px',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.8)'
            });

            const confirmCardSlots = [];
            for (let i = 0; i < 1; i++) {
                const cardContainer = hPanel.CreateVisualElement(confirmCardsRow);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '250px',
                    height: '320px',
                    backgroundColor: 'rgba(0, 0, 0, 0)',
                    padding: '20px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: 'rgba(102, 102, 102, 1)',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginRight: '25px'
                });

                const cardLabel = hPanel.CreateLabel(undefined, cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    backgroundColor: 'rgba(0, 0, 0, 0)',
                    width: '100%',
                    height: '100%',
                    color: '#000000',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
                });
                confirmCardSlots.push({ container: cardContainer, label: cardLabel });
            }

            const confirmButtonsRow = hPanel.CreateVisualElement(confirmOverlay);
            await confirmButtonsRow.Async();
            confirmButtonsRow.SetStyles({
                display: 'flex',
                flexDirection: 'row',
                backgroundColor: 'rgba(0, 0, 0, 0)' // This should be fully transparent
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

            return {
                root: sliceRoot,
                wedgeMat: matNormal,
                statusObj, sRoot, nameText, statusText, timerText,
                handObj, hRoot, actionsRow, playBtn, drawBtn, passBtn, unoBtn, selectionLabel, cardsGrid, cardUIs,
                confirmOverlay, confirmMsg, confirmCardSlots, confirmButtonsRow, hPanel, turnIndicatorBtn
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
                height: '920px',
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
            creditLabel.text = "UNO! is a registered trademark of Mattel, Inc.\nAdapted for Banter by FireRat\nBeta 0.3";
            creditLabel.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#aaaaaa', fontSize: '25px', marginTop: '20px', textAlign: 'center' });
            this.ui.creditLabel = creditLabel;

            // Current Card Display Area
            const currentCardContainer = panel.CreateVisualElement(rootEl);
            await currentCardContainer.Async();
            currentCardContainer.SetStyles({
                display: 'none',
                width: '450px',
                height: '300px',
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
                fontSize: '48px',
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
            slice.confirmCardSlots.forEach(slot => slot.container.SetStyles({ display: 'none' }));
            if (slice.colorChoiceRow) slice.colorChoiceRow.SetStyles({ display: 'none' });
            if (slice.confirmButtonsRow) slice.confirmButtonsRow.SetStyles({ display: 'none' });

            if (confirmationType === 'choose-color') {
                if (!slice.colorChoiceRow) {
                    slice.colorChoiceRow = slice.hPanel.CreateVisualElement(slice.confirmOverlay);
                    slice.colorChoiceRow.Async().then(() => {
                        slice.colorChoiceRow.SetStyles({
                            display: 'flex',
                            flexDirection: 'row',
                            marginBottom: '30px',
                            backgroundColor: 'rgba(0,0,0,0)'
                        });
                        const createColorBtn = async (colorName, hexColor) => {
                            const btn = slice.hPanel.CreateButton(slice.colorChoiceRow);
                            await btn.Async();
                            btn.text = colorName.toUpperCase();
                            btn.SetStyles({
                                backgroundColor: hexColor,
                                color: 'white',
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
                                this.isConfirmationDialogOpen = false;
                                slice.confirmOverlay.SetStyles({ display: 'none' });
                            });
                        };
                        createColorBtn("RED", "#F44336");
                        createColorBtn("BLUE", "#2196F3");
                        createColorBtn("GREEN", "#4CAF50");
                        createColorBtn("YELLOW", "#FFEB3B");
                        slice.colorChoiceRow.SetStyles({ display: 'flex' });
                    });
                } else {
                    slice.colorChoiceRow.SetStyles({ display: 'flex' });
                }
            } else {
                if (slice.confirmButtonsRow) slice.confirmButtonsRow.SetStyles({ display: 'flex' });
                if (previewCards && previewCards.length > 0) {
                    previewCards.forEach((card, idx) => {
                        if (idx < slice.confirmCardSlots.length) {
                            slice.confirmCardSlots[idx].label.text = card.text;
                            slice.confirmCardSlots[idx].container.SetStyles({ display: 'flex', backgroundColor: card.color || 'rgba(51, 51, 51, 1)' }); // Changed from #ffffff
                        }
                    });
                }
            }
        }


        // Helper to get card text for Uno
        getCardText(card) {
            if (!card) return "";
            if (card.type === "wild" || card.type === "wild_draw_4") {
                return `${card.value.replace('_', ' ').toUpperCase()}\n(Color: ${card.chosenColor || '?'})`;
            }
            return `${card.color.toUpperCase()} ${card.value}`;
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
            if (e.detail.changes.some(c => c.property === STATE_KEY)) {
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

            const newGameStateRaw = scene.spaceState.public[STATE_KEY];
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
                    this.gameState = {
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
                        lastAction: null,
                        currentHostUid: null,
                        turnStartTime: null, // Initialize turnStartTime
                        turnDuration: TURN_DURATION // Initialize turnDuration
                    };
                    this.log("Game state not found in space, initializing local default state.");
                } else {
                    // If newGameState is null but this.gameState exists, it means the state was cleared in space.
                    // Reset local state to default.
                    this.gameState = {
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
                        lastAction: null,
                        currentHostUid: null,
                        turnStartTime: null, // Reset turnStartTime
                        turnDuration: TURN_DURATION // Reset turnDuration
                    };
                    this.log("Game state cleared in space, resetting local state.");
                }
                this.playersInitiallyLoaded = {}; // Clear if state is reset
            } else {
                // Only update if the new state is different from the current state to avoid unnecessary re-renders
                if (JSON.stringify(this.gameState) !== JSON.stringify(newGameState)) {
                    this.gameState = newGameState;
                    this.log("Synced game state from BanterSpace:", this.gameState);

                    // Populate playersInitiallyLoaded based on the newly synced state
                    this.playersInitiallyLoaded = {};
                    for (const playerId in this.gameState.players) {
                        this.playersInitiallyLoaded[playerId] = this.gameState.players[playerId].isDisconnected;
                    }
                }
            }
            this.updateUI();
        }

        // Helper to update and save game state
        updateState(patch) {
            if (!this.gameState) {
                this.log("Cannot update state: gameState is null.");
                return;
            }
            Object.assign(this.gameState, patch);
            scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(this.gameState) });
            this.sync(); // Sync immediately after updating the space state
        }

        // Function to send actions and update BanterSpace state
        async sendAction(action, data = {}) {
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

            let currentSpaceStateRaw = scene.spaceState.public[STATE_KEY]; // Access public state
            let currentSpaceState;
            try {
                currentSpaceState = currentSpaceStateRaw ? JSON.parse(currentSpaceStateRaw) : null;
            } catch (error) {
                this.log("Error parsing current space state:", error);
                currentSpaceState = null;
            }

            // If no state exists in space, initialize a default state for processing
            if (!currentSpaceState) {
                currentSpaceState = {
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
                    lastAction: null,
                    currentHostUid: null, // Initialize currentHostUid
                    turnStartTime: null, // Initialize turnStartTime
                    turnDuration: TURN_DURATION // Initialize turnDuration
                };
            }

            // Create a deep copy to modify
            let newState = JSON.parse(JSON.stringify(currentSpaceState));

            // Apply game logic based on action
            const updatedState = this.applyGameLogic(newState, action, localUser.uid, localUser.name, data);

            if (updatedState) {
                // Only update if logic applied changes
                await scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(updatedState) }); // Stringify the state
                this.sync(); // Sync immediately after updating the space state
            }
        }

        // Placeholder for Uno game logic
        applyGameLogic(state, action, userId, userName, data) {
            // Initialize state if it's empty or if currentHostUid is missing
            if (!state.players || state.currentHostUid === undefined) {
                state = {
                    players: {},
                    deck: [],
                    discardPile: [],
                    currentPlayerId: null,
                    currentCard: null,
                    direction: 1, // 1 for clockwise, -1 for counter-clockwise
                    gameStarted: false,
                    pendingDraw: 0,
                    winner: null,
                    awaitingColorChoice: null, // New state for wild card color choice
                    lastPlayedWildCard: null, // Store the wild card that needs color choice
                    lastAction: null, // For debugging/history
                    currentHostUid: null, // Initialize currentHostUid
                    turnStartTime: null, // Initialize turnStartTime
                    turnDuration: TURN_DURATION // Initialize turnDuration
                };
            }

            const player = state.players[userId];

            switch (action) {
                case "join-game":
                    if (!player && !state.gameStarted) {
                        state.players[userId] = {
                            id: userId,
                            name: userName,
                            hand: [],
                            score: 0,
                            position: Object.keys(state.players).length, // Assign position
                            hasCalledUno: false,
                            hasDrawnThisTurn: false // Initialize new property
                        };
                        this.playSound("join");
                    }
                    break;
                case "leave-game":
                    if (player) {
                        delete state.players[userId];
                        // Reassign positions if needed, or handle empty seats
                        const playerIds = Object.keys(state.players);
                        playerIds.forEach((id, idx) => {
                            state.players[id].position = idx;
                        });
                        this.playSound("leave");
                        if (playerIds.length < 2 && state.gameStarted) {
                            state.gameStarted = false; // End game if not enough players
                            state.winner = null;
                        }
                    }
                    break;
                case "start-game":
                    // Only host can start the game
                    if (this.isHost() && !state.gameStarted && Object.keys(state.players).length >= 2) {
                        state = this.initializeNewGame(state);
                        this.playSound("start");
                    }
                    break;
                case "play-card":
                    // Logic to validate and play a card
                    if (player && state.currentPlayerId === userId && !state.winner && !state.awaitingColorChoice) {
                        const cardToPlay = player.hand.find(c => c.id === data.cardId);
                        if (cardToPlay && this.isValidPlay(cardToPlay, state.currentCard, state.pendingDraw)) {
                            player.hand = player.hand.filter(c => c.id !== data.cardId);
                            state.discardPile.push(cardToPlay);
                            player.hasDrawnThisTurn = false; // Reset after playing a card
                            state.turnStartTime = Date.now(); // Reset timer on action

                            if (cardToPlay.type === "wild" || cardToPlay.type === "wild_draw_4") {
                                // Wild card played, now await color choice from this player
                                state.awaitingColorChoice = userId;
                                state.lastPlayedWildCard = cardToPlay;
                                // Do NOT set currentCard or apply effects yet.
                                // Do NOT call nextTurn yet.
                                this.playSound("play_card");
                            } else {
                                state.currentCard = cardToPlay;
                                this.applyCardEffect(state, cardToPlay);

                                // Removed automatic Uno penalty from here. It will be checked in nextTurn.
                                // if (player.hand.length === 1 && !player.hasCalledUno) {
                                //     this.log(`${player.name} did not call UNO! Drawing 2 cards.`);
                                //     this.drawCardsForPlayer(state, userId, 2);
                                // }
                                // player.hasCalledUno = false; // Reset for next turn

                                if (player.hand.length === 0) {
                                    state.winner = userId;
                                    state.gameStarted = false;
                                    this.playSound("win");
                                } else {
                                    this.nextTurn(state);
                                    this.playSound("play_card");
                                }
                            }
                        } else {
                            this.log("Invalid card play attempted by", userName);
                        }
                    }
                    break;
                case "draw-card":
                    if (player && state.currentPlayerId === userId && !state.winner && !state.awaitingColorChoice) {
                        if (state.pendingDraw > 0) {
                            this.drawCardsForPlayer(state, userId, state.pendingDraw);
                            state.pendingDraw = 0;
                            state.turnStartTime = Date.now(); // Reset timer on action
                            this.nextTurn(state); // Skip this player's turn after drawing forced cards
                        } else {
                            this.drawCardsForPlayer(state, userId, 1);
                            state.turnStartTime = Date.now(); // Reset timer on action
                        }
                        player.hasDrawnThisTurn = true; // Player has drawn a card this turn
                        this.playSound("draw_card");
                        // Do not call nextTurn here if only 1 card drawn, player can still play or pass
                    }
                    break;
                case "pass-turn":
                    if (player && state.currentPlayerId === userId && !state.winner && !state.awaitingColorChoice && player.hasDrawnThisTurn) {
                        player.hasDrawnThisTurn = false; // Reset for next turn
                        state.turnStartTime = Date.now(); // Reset timer on action
                        this.nextTurn(state);
                        this.playSound("pass"); // Assuming a 'pass' sound exists
                    } else {
                        this.log("Invalid pass-turn action by", userName);
                    }
                    break;
                case "call-uno":
                    if (player && (player.hand.length === 1 || player.hand.length === 2)) {
                        player.hasCalledUno = true;
                        this.playSound("uno");
                    }
                    break;
                case "choose-wild-color":
                    if (state.awaitingColorChoice === userId && state.lastPlayedWildCard && data.chosenColor) {
                        state.lastPlayedWildCard.chosenColor = data.chosenColor;
                        state.currentCard = state.lastPlayedWildCard;
                        this.applyCardEffect(state, state.currentCard);
                        state.turnStartTime = Date.now(); // Reset timer on action

                        // Removed automatic Uno penalty from here. It will be checked in nextTurn.
                        // const wildCardPlayer = state.players[userId];
                        // if (wildCardPlayer && wildCardPlayer.hand.length === 1 && !wildCardPlayer.hasCalledUno) {
                        //     this.log(`${wildCardPlayer.name} did not call UNO! Drawing 2 cards.`);
                        //     this.drawCardsForPlayer(state, userId, 2);
                        // }
                        // if (wildCardPlayer) wildCardPlayer.hasCalledUno = false; // Reset for next turn

                        if (player.hand.length === 0) { // Use 'player' here as it's the one who played the card
                            state.winner = userId;
                            state.gameStarted = false;
                            this.playSound("win");
                        } else {
                            this.nextTurn(state);
                            this.playSound("play_card"); // Or a specific wild card sound
                        }

                        state.awaitingColorChoice = null;
                        state.lastPlayedWildCard = null;
                    } else {
                        this.log("Invalid choose-wild-color action by", userName);
                    }
                    break;
                case "timeout-player":
                    const timedOutPlayerId = data.timedOutPlayerId;
                    if (state.players[timedOutPlayerId]) {
                        this.log(`Player ${timedOutPlayerId} timed out and is being removed.`);
                        delete state.players[timedOutPlayerId];

                        // Reassign positions
                        const playerIds = Object.keys(state.players);
                        playerIds.forEach((id, idx) => {
                            state.players[id].position = idx;
                        });

                        // If the timed out player was the current player, advance turn
                        if (state.currentPlayerId === timedOutPlayerId) {
                            this.nextTurn(state); // nextTurn will handle setting turnStartTime for the new current player
                        }

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
                            state.turnStartTime = null; // No active turn, no timer
                        }
                        if (data.playSound !== false) { // Only play sound if explicitly not false
                            this.playSound("leave");
                        }
                    }
                    break;
            }

            state.lastAction = { action, userId, data, timestamp: Date.now() };
            return state;
        }

        // Uno Game Logic Helpers
        initializeNewGame(state) {
            state.deck = this.createUnoDeck();
            this.shuffleDeck(state.deck);
            state.discardPile = [];
            state.gameStarted = true;
            state.winner = null;
            state.pendingDraw = 0;
            state.direction = 1;
            state.awaitingColorChoice = null;
            state.lastPlayedWildCard = null;
            state.turnStartTime = null; // Reset turnStartTime
            state.turnDuration = TURN_DURATION; // Set turnDuration

            const playerIds = Object.keys(state.players);
            playerIds.forEach(id => {
                state.players[id].hand = [];
                state.players[id].hasCalledUno = false;
                state.players[id].hasDrawnThisTurn = false; // Initialize for new game
                this.drawCardsForPlayer(state, id, 7); // Deal 7 cards
            });

            // Start with a non-action card on the discard pile
            let firstCard;
            do {
                firstCard = state.deck.shift();
                if (firstCard.type === "action" || firstCard.type === "wild" || firstCard.type === "wild_draw_4") {
                    state.deck.push(firstCard); // Put action cards back and reshuffle
                    this.shuffleDeck(state.deck);
                }
            } while (firstCard.type === "action" || firstCard.type === "wild" || firstCard.type === "wild_draw_4");

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

        isValidPlay(cardToPlay, currentCard, pendingDraw) {
            if (!cardToPlay || !currentCard) return false;

            // If there's a pending draw, only a +2 or +4 can be played
            if (pendingDraw > 0) {
                return (cardToPlay.value === "draw_2" && cardToPlay.color === currentCard.color) ||
                       cardToPlay.value === "wild_draw_4";
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
            const playerIds = Object.keys(state.players);
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

        nextTurn(state) {
            const playerIds = Object.keys(state.players);
            if (playerIds.length === 0) {
                state.currentPlayerId = null;
                state.turnStartTime = null; // No current player, no timer
                return;
            }

            const previousPlayerId = state.currentPlayerId; // Store current player before advancing
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

            // Apply Uno penalty to previous player if applicable
            if (previousPlayer && previousPlayer.hand.length === 1 && !previousPlayer.hasCalledUno) {
                this.log(`${previousPlayer.name} did not call UNO! Drawing 2 cards.`);
                this.drawCardsForPlayer(state, previousPlayerId, 2);
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

        playSound(name) {
            if (this.isMuted) return;
            const now = Date.now();
            this.audioTracker = this.audioTracker || {};
            if (this.audioTracker[name] && now - this.audioTracker[name] < 100) return;
            this.audioTracker[name] = now;

            // Sound assets.
            const soundMap = {
                "join": "https://uno.firer.at/Assets/playerJoin.ogg",
                "leave": "https://uno.firer.at/Assets/playerKick.ogg",
                "start": "https://uno.firer.at/Assets/gameStart.ogg",
                "play_card": "https://uno.firer.at/Assets/card_flick.ogg",
                "draw_card": "https://uno.firer.at/Assets/card_flick.ogg",
                "uno": "https://uno.firer.at/Assets/ding%20ding.ogg",
                "win": "https://uno.firer.at/Assets/fanfare with pop.ogg",
                "pass": "https://uno.firer.at/Assets/ding%20ding.ogg"
            };
            const url = soundMap[name];
            if (!url) {
                this.log("Sound not found:", name);
                return;
            }

            const audio = new Audio(url);
            audio.crossOrigin = "anonymous";
            audio.volume = 0.3;
            audio.play().catch(e => this.log("Audio play failed: " + e.message));
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
                        if (isMyTurn && this.gameState.awaitingColorChoice === localUid && this.gameState.lastPlayedWildCard) {
                            if (!this.isConfirmationDialogOpen) { // Prevent opening multiple times
                                this.confirm("Choose a color for your Wild card:", (chosenColor) => {
                                    this.sendAction("choose-wild-color", { chosenColor });
                                }, null, 'choose-color');
                            }
                        } else {
                            // Normal hand display logic
                            slice.selectionLabel.text = this.selectedCardIds.length > 0 ? "Card Selected" : "";

                            let selectedCard = null;
                            if (this.selectedCardIds.length > 0) {
                                selectedCard = localPlayer.hand.find(c => c.id === this.selectedCardIds[0]);
                            }
                            const canPlaySelectedCard = selectedCard && this.isValidPlay(selectedCard, this.gameState.currentCard, this.gameState.pendingDraw);

                            // First, hide all card UI elements
                            slice.cardUIs.forEach(cardUI => {
                                cardUI.container.SetStyles({ display: 'none' });
                            });

                            localPlayer.hand.forEach((card, idx) => {
                                const cardUI = slice.cardUIs[idx];
                                if (cardUI && card) {
                                    const isSelected = this.selectedCardIds.includes(card.id);
                                    const isValid = this.isValidPlay(card, this.gameState.currentCard, this.gameState.pendingDraw);
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

                            slice.playBtn.SetStyles({ display: isMyTurn && canPlaySelectedCard ? 'flex' : 'none' });
                            slice.drawBtn.SetStyles({ display: isMyTurn && this.selectedCardIds.length === 0 && !localPlayer.hasDrawnThisTurn ? 'flex' : 'none' });
                            slice.passBtn.SetStyles({ display: isMyTurn && localPlayer.hasDrawnThisTurn && this.selectedCardIds.length === 0 ? 'flex' : 'none' });
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
                case 'blue': return '#0000FF';
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
                    this.log(`Player ${userId} grace period expired. Marking for removal.`);
                    // Determine if sound should be played:
                    // Play sound if the player was NOT disconnected when the state was initially loaded (i.e., they disconnected during this session).
                    const wasInitiallyDisconnected = this.playersInitiallyLoaded.hasOwnProperty(userId) && this.playersInitiallyLoaded[userId];
                    const playSound = !wasInitiallyDisconnected;
                    this.sendAction("timeout-player", { timedOutPlayerId: userId, playSound: playSound });
                    return; // Exit and wait for next tick as sendAction triggers update
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
                    // The host should send an action to remove the player
                    this.sendAction("timeout-player", { timedOutPlayerId: this.gameState.currentPlayerId, playSound: true });
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