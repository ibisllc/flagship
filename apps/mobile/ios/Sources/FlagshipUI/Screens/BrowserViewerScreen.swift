import SwiftUI
import FlagshipAPI

/// P8 — server-side browser viewer.
///
/// Renders the JPEG framebuffer the daemon pushes over WS and forwards
/// every touch as a `mouseDown` / `mouseMove` / `mouseUp` triple to the
/// headless Chromium. The daemon's `DomainGate` enforces which sites the
/// browser may navigate to — the client only streams + relays.
///
/// Mirrors apps/web/public/webapp/views/browser-viewer.js byte-for-byte:
/// same WS path, same JSON wire shape, same `toImgCoords` math.
public struct BrowserViewerScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: BrowserViewerViewModel
    @State private var inDrag = false
    @State private var keyboardVisible = false
    @State private var keyInput = ""
    @FocusState private var keyFieldFocused: Bool

    public init(vm: BrowserViewerViewModel) {
        self.vm = vm
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(spacing: 0) {
            statusBar(c: c)
            GeometryReader { geo in
                framebufferView(viewport: geo.size, c: c)
            }
            hiddenKeyboardField()
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Browser")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { vm.start() }
        .onDisappear {
            keyboardVisible = false
            keyFieldFocused = false
            vm.stop()
        }
    }

    @ViewBuilder
    private func statusBar(c: FSColors) -> some View {
        HStack(spacing: FS.space.s2) {
            switch vm.status {
            case .idle:
                Text("Idle").foregroundColor(c.textMuted)
            case .connecting:
                ProgressView().controlSize(.small)
                Text("Connecting…").foregroundColor(c.textMuted)
            case .streaming:
                Image(systemName: "dot.radiowaves.left.and.right").foregroundColor(c.success)
                Text("Streaming tab \(vm.tabId)").foregroundColor(c.text)
            case .closed:
                Text("Stream closed").foregroundColor(c.textMuted)
            case .failed(let msg):
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.danger)
                Text(msg).foregroundColor(c.danger).lineLimit(1)
            }
            Spacer()
            Button {
                keyboardVisible.toggle()
                keyFieldFocused = keyboardVisible
                if !keyboardVisible { keyInput = "" }
            } label: {
                Image(systemName: keyboardVisible ? "keyboard.chevron.compact.down" : "keyboard")
                    .foregroundColor(keyboardVisible ? c.primary : c.textMuted)
            }
            .accessibilityIdentifier("browser-viewer-toggle-keyboard")
        }
        .padding(.horizontal, FS.space.s4)
        .padding(.vertical, FS.space.s2)
        .background(c.bg)
    }

    @ViewBuilder
    private func hiddenKeyboardField() -> some View {
        if keyboardVisible {
            TextField("", text: $keyInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .focused($keyFieldFocused)
                .opacity(0.001)
                .frame(height: 1)
                .accessibilityIdentifier("browser-viewer-key-input")
                .onChange(of: keyInput) { oldValue, newValue in
                    let events = BrowserViewerViewModel.keyEvents(from: oldValue, to: newValue)
                    guard !events.isEmpty else { return }
                    Task {
                        for e in events {
                            await vm.sendKey(eventType: e.eventType, key: e.key, code: e.code)
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private func framebufferView(viewport: CGSize, c: FSColors) -> some View {
        ZStack {
            c.surfaceSunken
            if let img = vm.frame {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: viewport.width, height: viewport.height)
                    .accessibilityIdentifier("browser-viewer-frame")
            } else {
                VStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("Waiting for first frame…").foregroundColor(c.textMuted)
                }
            }
        }
        .contentShape(Rectangle())
        .gesture(dragGesture(viewport: viewport))
    }

    private func dragGesture(viewport: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { val in
                let (x, y) = BrowserViewerViewModel.toImageCoords(
                    touchX: val.location.x,
                    touchY: val.location.y,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    imageWidth: vm.frameWidth,
                    imageHeight: vm.frameHeight
                )
                if !inDrag {
                    inDrag = true
                    Task { await vm.sendMouseDown(x: x, y: y) }
                } else {
                    Task { await vm.sendMouseMove(x: x, y: y) }
                }
            }
            .onEnded { val in
                let (x, y) = BrowserViewerViewModel.toImageCoords(
                    touchX: val.location.x,
                    touchY: val.location.y,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    imageWidth: vm.frameWidth,
                    imageHeight: vm.frameHeight
                )
                inDrag = false
                Task { await vm.sendMouseUp(x: x, y: y) }
            }
    }
}
