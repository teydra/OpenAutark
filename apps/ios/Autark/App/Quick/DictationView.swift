// Owns: the app's dictation sheet (DictateIntent, the Control Center's "Diktat", autark://dictate): it records with the microphone
// (AVAudioRecorder, AAC in .m4a), and on "Senden" the recording goes to the PC (files.upload), the PC transcribes it
// (voice.transcribe, the same as the phone page and Android's Dictation) and the text goes as a dictated message into the chosen chat
// (messages.send with speech {source: 'endpoint'}); when the PC cannot transcribe, the recording itself goes as an attachment.
// Recording starts in the app's foreground: iOS lets an App Intent record from the Lock Screen only as an AudioRecordingIntent with a
// Live Activity that the app started in the foreground (Apple's AudioRecordingIntent documentation and forums, iOS 18), so the
// dictation opens the app.
// Never: keeps a recording after it was sent or dropped, or records without the person's tap.
import AVFoundation
import SwiftUI
import AutarkCore

@MainActor
final class Dictation: ObservableObject {
    @Published var recording = false
    @Published var seconds = 0
    @Published var line = "Tap the microphone to speak."
    @Published var busy = false
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private let file = FileManager.default.temporaryDirectory.appendingPathComponent("autark-dictation.m4a")

    func toggle() { recording ? stop() : start() }

    func start() {
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in
                guard granted else { self.line = "Allow the microphone for Autark in Settings to dictate."; return }
                do {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.record, mode: .spokenAudio)
                    try session.setActive(true)
                    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                                   AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue]
                    let next = try AVAudioRecorder(url: self.file, settings: settings)
                    guard next.record() else { self.line = "The microphone did not start."; return }
                    self.recorder = next
                    self.recording = true
                    self.seconds = 0
                    self.line = "Listening…"
                    self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in Task { @MainActor in self.seconds += 1 } }
                } catch {
                    self.line = "The microphone did not start: " + error.localizedDescription
                }
            }
        }
    }

    func stop() {
        recorder?.stop()
        recorder = nil
        timer?.invalidate()
        timer = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        line = seconds > 0 ? "Recorded \(seconds) s. Send it, or tap the microphone again." : "Tap the microphone to speak."
    }

    /// Sends the recording to `chat`: transcribed text when the PC can, else the recording itself. True when it went.
    func send(to chat: ChatRef) async -> Bool {
        if recording { stop() }
        guard let data = try? Data(contentsOf: file), !data.isEmpty else { line = "Nothing recorded yet."; return false }
        busy = true
        defer { busy = false }
        line = "Sending to " + chat.title + "…"
        do {
            let link = try await QuickCenter.caller()
            let audio = OutFile(name: "dictation.m4a", mime: "audio/mp4", data: Bytes(data))
            try await Task.detached {
                let stored = try QuickSend.store(link, audio, chat: chat.id)
                let id = QuickSend.clientId()
                if let fileId = stored["fileId"] as? String,
                   let heard = try? link.request("voice.transcribe", ["fileId": fileId, "chatId": chat.id], timeoutMs: 60_000) as? JSONObject,
                   let text = Json.str(heard, "text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    var params = QuickSend.message(chat: chat.id, text: text, attachments: [], clientId: id)
                    params["speech"] = ["source": "endpoint"] as JSONObject
                    _ = try link.request("messages.send", params, timeoutMs: QuickSend.callMs)
                } else {
                    _ = try link.request("messages.send", QuickSend.message(chat: chat.id, text: "", attachments: [stored], clientId: id), timeoutMs: QuickSend.callMs)
                }
            }.value
            QuickCenter.lastChat = chat
            try? FileManager.default.removeItem(at: file)
            seconds = 0
            line = "Sent to " + chat.title + "."
            return true
        } catch {
            line = (error as? AutarkError)?.message ?? error.localizedDescription
            return false
        }
    }

    func drop() {
        if recording { stop() }
        try? FileManager.default.removeItem(at: file)
    }
}

struct DictationView: View {
    @ObservedObject var model: AppModel
    @StateObject private var dictation = Dictation()
    @State private var chats = [ChatRef]()
    @State private var chat: ChatRef?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Picker("Chat", selection: $chat) {
                    ForEach(chats) { one in Text(one.title).tag(Optional(one)) }
                }
                .pickerStyle(.menu)
                Spacer()
                Button(action: dictation.toggle) {
                    Image(systemName: dictation.recording ? "stop.circle.fill" : "mic.circle.fill")
                        .resizable().frame(width: 120, height: 120)
                        .foregroundStyle(dictation.recording ? Color.red : Color.accentColor)
                }
                .accessibilityLabel(dictation.recording ? "Stop" : "Record")
                Text(dictation.recording ? "\(dictation.seconds) s" : " ").font(.title3.monospacedDigit())
                Text(dictation.line).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Spacer()
            }
            .padding()
            .navigationTitle("Diktat an Autark")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dictation.drop(); model.dictating = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Senden") {
                        guard let chat = chat else { return }
                        Task { if await dictation.send(to: chat) { model.dictating = false } }
                    }
                    .disabled(chat == nil || dictation.busy)
                }
            }
            .task {
                chats = await QuickCenter.chats()
                chat = QuickCenter.lastChat.flatMap { last in chats.first { $0.id == last.id } } ?? chats.first
                if chats.isEmpty { dictation.line = "Autark could not list your chats – is the PC online?" }
                else if !dictation.recording { dictation.start() } // the person asked to dictate: it listens at once
            }
        }
    }
}
