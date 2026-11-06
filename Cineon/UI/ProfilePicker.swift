import SwiftUI

struct ProfileAvatar: View {
    let profile: Profile
    var size: CGFloat = 28
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Circle().fill(palette.silver)
            Text(String(profile.name.prefix(1)).uppercased())
                .font(Typeface.bold(size * 0.48))
                .foregroundStyle(palette.onSilver)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// "Who's watching?" Each person's card is the poster of the last thing they watched, so the
/// picker is a little portrait of the family's taste, and the only colour on screen is film.
struct ProfilePicker: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isAdding = false
    @State private var newName = ""
    @State private var isEditing = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            palette.canvas.ignoresSafeArea()
            VStack(spacing: 34) {
                Text("Who's watching?")
                    .font(Typeface.title(38))
                    .foregroundStyle(palette.ink)

                HStack(alignment: .top, spacing: 24) {
                    ForEach(app.profiles.profiles) { profile in
                        ProfileCard(profile: profile, isEditing: isEditing)
                    }
                    addCard
                }

                HStack(spacing: 10) {
                    if app.profiles.profiles.count > 1 {
                        Button(isEditing ? "Done" : "Edit profiles") {
                            withAnimation(Motion.quick) { isEditing.toggle() }
                        }
                        .buttonStyle(OutlineButtonStyle())
                    }
                    Button("Close") { app.isProfilePickerVisible = false }
                        .buttonStyle(OutlineButtonStyle())
                }
            }
            .padding(40)
        }
        .onKeyDown { event in
            guard event.keyCode == KeyCode.escape else { return false }
            app.isProfilePickerVisible = false
            return true
        }
    }

    private var addCard: some View {
        VStack(spacing: 10) {
            if isAdding {
                VStack(spacing: 8) {
                    TextField("Name", text: $newName)
                        .textFieldStyle(.plain)
                        .font(Typeface.ui(14))
                        .multilineTextAlignment(.center)
                        .padding(8)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .focused($nameFocused)
                        .onSubmit(addProfile)
                    Button("Add", action: addProfile)
                        .buttonStyle(SilverButtonStyle())
                }
                .frame(width: 140, height: 210)
            } else {
                Button {
                    withAnimation(Motion.quick) { isAdding = true }
                    nameFocused = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 24, weight: .light))
                        .foregroundStyle(palette.ink2)
                        .frame(width: 140, height: 210)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(palette.line, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add a profile")
            }
            Text("Add someone")
                .font(Typeface.ui(14))
                .foregroundStyle(palette.ink3)
        }
    }

    private func addProfile() {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let profile = app.profiles.add(name: name)
        newName = ""
        isAdding = false
        app.switchProfile(to: profile)
    }
}

struct ProfileCard: View {
    let profile: Profile
    let isEditing: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false
    @State private var confirmingDelete = false

    private var isCurrent: Bool { app.session.profile.id == profile.id }

    var body: some View {
        VStack(spacing: 10) {
            Button {
                app.switchProfile(to: profile)
            } label: {
                ZStack(alignment: .bottomLeading) {
                    RemoteImage(url: posterURL, maxPixel: 420) {
                        ZStack {
                            palette.raised
                            ProfileAvatar(profile: profile, size: 64)
                        }
                    }
                    .frame(width: 140, height: 210)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    if posterURL != nil {
                        ProfileAvatar(profile: profile, size: 30).padding(8)
                    }
                }
                .scaleEffect(isHovered ? 1.03 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.72), value: isHovered)
            }
            .buttonStyle(.plain)
            .onHover { isHovered = $0 }

            Text(profile.name)
                .font(Typeface.ui(14, isCurrent ? .semibold : .regular))
                .foregroundStyle(isCurrent ? palette.ink : palette.ink2)

            if isEditing, app.profiles.profiles.count > 1, !isCurrent {
                Button("Delete") { confirmingDelete = true }
                    .buttonStyle(OutlineButtonStyle())
                    .confirmationDialog(
                        "Delete \(profile.name)'s profile?",
                        isPresented: $confirmingDelete
                    ) {
                        Button("Delete profile and all its data", role: .destructive) {
                            app.profiles.delete(profile.id)
                        }
                    } message: {
                        Text("Their library, timeline and site logins are removed for good.")
                    }
            }
        }
    }

    private var posterURL: URL? {
        isCurrent ? (app.session.latestPosterURL ?? profile.lastPosterURL) : profile.lastPosterURL
    }
}
