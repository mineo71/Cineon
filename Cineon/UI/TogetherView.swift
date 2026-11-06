import SwiftUI

/// Watching with friends: parties, challenges and lists shared by code.
struct TogetherView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var code = ""

    private var together: TogetherModel { app.session.together }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                header
                if together.isAvailable {
                    PartySection()
                    ChallengesSection()
                    SharesSection()
                } else {
                    Text("Together needs a server address, and this build has none. Set CineonTogetherURL in Info.plist.")
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink2)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.top, 34)
            .padding(.bottom, 60)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        .background(palette.cardFill)
        .task { await together.refreshChallenges() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Together")
                .font(Typeface.title(30))
                .foregroundStyle(palette.ink)
            Text("Watch the same film at the same second, race friends to the end of a series, or send them what you've seen. Everything works with a six-letter code. No accounts.")
                .font(Typeface.ui(13))
                .foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            if together.isAvailable {
                HStack(spacing: 8) {
                    TextField("Enter a code, like K7Q-2MX", text: $code)
                        .textFieldStyle(.plain)
                        .font(Typeface.time(15, .medium))
                        .foregroundStyle(palette.ink)
                        .padding(.horizontal, 12)
                        .frame(width: 260, height: 36)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .onSubmit(join)
                    Button("Open", action: join)
                        .buttonStyle(SilverButtonStyle())
                        .disabled(ShareCode.normalize(code).count != 6 || together.isWorking)
                    if together.isWorking {
                        ProgressView().controlSize(.small)
                    }
                }
            }
        }
    }

    private func join() {
        guard ShareCode.normalize(code).count == 6 else { return }
        together.enter(code: code)
        code = ""
    }
}

// MARK: Party

private struct PartySection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    var body: some View {
        if let party = together.party {
            PartyStage(party: party)
        } else {
            PartyInvite()
        }
    }
}

/// No party yet: what's playing, ready to share, or a nudge to start something.
private struct PartyInvite: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    private var playing: BrowserTab? {
        guard let tab = app.browser.playingTab ?? app.browser.selected, let media = tab.media,
              media.duration >= WatchTracker.minimumDuration else { return nil }
        return tab
    }

    var body: some View {
        let tab = playing
        let title = tab?.linkedTitleID.flatMap { app.library.titles[$0] }
        HStack(alignment: .center, spacing: 22) {
            Group {
                if let title {
                    PosterImage(title: title, width: 86, cornerRadius: 6, keepsColour: true)
                } else {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(palette.raised2)
                        .frame(width: 86, height: 129)
                        .overlay(Image(systemName: "play.rectangle.on.rectangle").font(.system(size: 24)).foregroundStyle(palette.ink3))
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Watch party")
                    .font(Typeface.title(26))
                    .foregroundStyle(palette.ink)
                Text(tab.map { "Invite friends to \(title?.name ?? $0.parsed?.name ?? $0.displayTitle). They open the same page and their player follows yours: play, pause, every jump. You can talk in the chat while you watch." }
                     ?? "Start a film on one of your sites, then come back here to invite people to it.")
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink2)
                    .frame(maxWidth: 460, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button {
                        if let tab { app.browser.select(tab) }
                        together.startParty()
                    } label: {
                        Label("Start a party", systemImage: "person.2.wave.2")
                    }
                    .buttonStyle(SilverButtonStyle(large: true))
                    .disabled(tab == nil || together.isWorking)
                    if tab == nil, let next = app.library.continueWatching.first {
                        Button("Open \(next.title.name)") { app.continueWatching(titleID: next.title.id) }
                            .buttonStyle(OutlineButtonStyle())
                    }
                }
                .padding(.top, 6)
            }
            Spacer(minLength: 0)
        }
        .padding(22)
        .background(StageBackground(posterURL: title?.posterURL))
    }
}

/// A poster's colours behind a card, blurred into light. The only colour comes from the film.
private struct StageBackground: View {
    let posterURL: URL?
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.raised
            if let posterURL {
                RemoteImage(url: posterURL, maxPixel: 300) { Color.clear }
                    .aspectRatio(contentMode: .fill)
                    .blur(radius: 50)
                    .saturation(1.4)
                    .opacity(palette.isDark ? 0.35 : 0.25)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(palette.line, lineWidth: 0.5))
    }
}

/// The party that's on: the film and where it is, who's here, the chat and the reactions.
private struct PartyStage: View {
    let party: PartyState
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var draft = ""
    @FocusState private var typing: Bool

    private var together: TogetherModel { app.session.together }
    private let reactions = ["😂", "😮", "😭", "❤️", "👏", "🍿"]

    private var syncLine: String {
        if together.isHost { return "You're the host. Everyone's player follows yours." }
        return "Following \(party.hostName), \(party.playing ? "playing" : "paused") at \(Timecode.string(party.expectedPosition))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 20) {
                RemoteImage(url: party.title?.posterURL, maxPixel: 300) { PosterPlaceholder(name: party.title?.name ?? "Party") }
                    .frame(width: 92, height: 138)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 7) {
                        Circle().fill(palette.gold).frame(width: 7, height: 7)
                        Text("Party on")
                            .font(Typeface.ui(12, .medium))
                            .foregroundStyle(palette.ink2)
                    }
                    Text(party.title?.name ?? "Watch party")
                        .font(Typeface.title(30))
                        .foregroundStyle(palette.ink)
                        .lineLimit(2)
                    Text(syncLine)
                        .font(Typeface.ui(13))
                        .foregroundStyle(palette.ink2)
                    HStack(spacing: 8) {
                        Image(systemName: party.playing ? "play.fill" : "pause.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(palette.ink2)
                        Text(Timecode.string(party.expectedPosition))
                            .font(Typeface.time(12, .medium))
                            .foregroundStyle(palette.ink)
                    }
                    .padding(.top, 2)
                }
                Spacer(minLength: 12)
                VStack(alignment: .trailing, spacing: 10) {
                    Ticket(code: party.code) { together.copyPartyCode() }
                    HStack(spacing: 8) {
                        if !together.isHost {
                            Button("Go to the film") { app.go(.web) }
                                .buttonStyle(OutlineButtonStyle())
                        }
                        Button(together.isHost ? "End party" : "Leave") { together.leaveParty() }
                            .buttonStyle(OutlineButtonStyle())
                    }
                }
            }
            .padding(22)

            members
                .padding(.horizontal, 22)
                .padding(.bottom, 16)

            Rectangle().fill(palette.line).frame(height: 0.5)

            HStack(alignment: .top, spacing: 0) {
                chat
                Rectangle().fill(palette.line).frame(width: 0.5)
                reactionPad
                    .frame(width: 190)
            }
            .frame(height: 260)
        }
        .background(StageBackground(posterURL: party.title?.posterURL))
    }

    private var members: some View {
        HStack(spacing: 16) {
            ForEach(party.members, id: \.personId) { member in
                let isMe = member.personId == together.personID
                let isHost = member.personId == party.hostId
                VStack(spacing: 5) {
                    PersonAvatar(name: member.name, petCode: isMe ? app.session.pet.code : member.pet, isMe: isMe, size: 44)
                        .overlay(alignment: .bottomTrailing) {
                            if isHost {
                                Image(systemName: "crown.fill")
                                    .font(.system(size: 9))
                                    .foregroundStyle(palette.gold)
                                    .padding(3)
                                    .background(Circle().fill(palette.cardFill))
                                    .accessibilityLabel("Host")
                            }
                        }
                    Text(isMe ? "You" : member.name)
                        .font(Typeface.ui(11.5, isMe ? .semibold : .regular))
                        .foregroundStyle(palette.ink2)
                        .lineLimit(1)
                }
                .frame(width: 60)
                .help(isHost ? "\(member.name), hosting" : member.name)
            }
            Spacer()
        }
    }

    private var chat: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if party.messages.isEmpty {
                            Text("Say hello. Messages also show over the film for a moment.")
                                .font(Typeface.ui(12.5))
                                .foregroundStyle(palette.ink3)
                                .padding(.top, 4)
                        }
                        ForEach(party.messages) { message in
                            ChatLine(message: message, isMe: message.personId == together.personID, myPet: app.session.pet.code)
                                .id(message.id)
                        }
                    }
                    .padding(16)
                }
                .scrollIndicators(.never)
                .onChange(of: party.messages.last?.id) { _, last in
                    guard let last else { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
            HStack(spacing: 8) {
                TextField("Message everyone", text: $draft)
                    .textFieldStyle(.plain)
                    .font(Typeface.ui(13))
                    .focused($typing)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(palette.onSilver)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(palette.silver))
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(palette.raised, in: Capsule())
            .padding(12)
        }
    }

    private var reactionPad: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("React")
                .font(Typeface.ui(12, .medium))
                .foregroundStyle(palette.ink3)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                ForEach(reactions, id: \.self) { emoji in
                    Button(emoji) { together.react(emoji) }
                        .font(.system(size: 24))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .buttonStyle(HoverButtonStyle(cornerRadius: 12, padding: EdgeInsets()))
                        .accessibilityLabel("React \(emoji)")
                }
            }
            if let last = party.reactions.last {
                Text("\(last.name) \(last.emoji)")
                    .font(Typeface.ui(11.5))
                    .foregroundStyle(palette.ink3)
                    .lineLimit(1)
            }
        }
        .padding(16)
    }

    private func send() {
        let text = draft
        draft = ""
        together.say(text)
        typing = true
    }
}

private struct ChatLine: View {
    let message: PartyMessage
    let isMe: Bool
    let myPet: String
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            PersonAvatar(name: message.name, petCode: isMe ? myPet : message.pet, isMe: isMe, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(isMe ? "You" : message.name)
                        .font(Typeface.ui(12, .semibold))
                        .foregroundStyle(palette.ink)
                    Text(Date(timeIntervalSince1970: message.at / 1000).formatted(date: .omitted, time: .shortened))
                        .font(Typeface.time(10.5))
                        .foregroundStyle(palette.ink3)
                }
                Text(message.text)
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The party's code as a cinema ticket: punched edge, big numbers, tap to copy.
private struct Ticket: View {
    let code: String
    let copy: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: copy) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Invite code")
                    .font(Typeface.ui(10.5))
                    .foregroundStyle(palette.ink3)
                HStack(spacing: 8) {
                    Text(ShareCode.display(code))
                        .font(Typeface.time(22, .bold))
                        .tracking(2)
                        .foregroundStyle(palette.ink)
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 11))
                        .foregroundStyle(palette.ink3)
                }
            }
            .padding(.leading, 18)
            .padding(.trailing, 14)
            .padding(.vertical, 9)
            .background(palette.raised2, in: TicketShape())
            .overlay(TicketShape().stroke(palette.line, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
        }
        .buttonStyle(.plain)
        .help("Copy the code to send to friends")
    }
}

/// A rounded rectangle with a half-circle punched out of each short side.
private nonisolated struct TicketShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path(roundedRect: rect, cornerRadius: 8, style: .continuous)
        let notch: CGFloat = 6
        path.addEllipse(in: CGRect(x: rect.minX - notch, y: rect.midY - notch, width: notch * 2, height: notch * 2))
        path.addEllipse(in: CGRect(x: rect.maxX - notch, y: rect.midY - notch, width: notch * 2, height: notch * 2))
        return path.normalized(eoFill: true)
    }
}

/// Someone as their pixel pet when they share one, otherwise their initial.
struct PersonAvatar: View {
    let name: String
    let petCode: String?
    var isMe = false
    var size: CGFloat = 26
    @Environment(\.palette) private var palette

    var body: some View {
        let pet: PixelPet? = petCode.flatMap { PixelPet(code: $0) }
        if let pet {
            PixelPetView(pet: pet, size: size * 0.86, animated: false)
                .frame(width: size, height: size)
                .background(Circle().fill(isMe ? AnyShapeStyle(palette.silver.opacity(0.35)) : AnyShapeStyle(palette.raised2)))
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(isMe ? AnyShapeStyle(palette.silver) : AnyShapeStyle(palette.line), lineWidth: isMe ? 1.5 : 1))
                .accessibilityLabel(name)
        } else {
            Avatar(name: name, isMe: isMe, size: size)
        }
    }
}

// MARK: Challenges

private struct ChallengesSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                SectionHeading(name: "Challenges")
                Spacer()
                Button {
                    app.sheet = .newChallenge
                } label: {
                    Label("New challenge", systemImage: "flag.checkered")
                }
                .buttonStyle(OutlineButtonStyle())
            }
            if together.challenges.isEmpty {
                Text("Pick a series or a film, send the code, and see who gets to the end first. Everyone's progress comes from what they actually watch.")
                    .font(Typeface.ui(13))
                    .foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 12) {
                    ForEach(together.challenges, id: \.code) { summary in
                        ChallengeCard(summary: summary, state: together.details[summary.code])
                    }
                }
            }
        }
    }
}

private struct ChallengeCard: View {
    let summary: ChallengeSummary
    let state: ChallengeState?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    private var subtitle: String {
        if let winner = state?.winnerName ?? summary.winnerName {
            return state?.winnerId == together.personID ? "You won. First to the end." : "\(winner) got there first"
        }
        let total = Int(summary.totalEpisodes)
        let goal = total > 1 ? "First to finish all \(total) episodes" : "First to finish it"
        return "\(goal) · \(Int(summary.memberCount)) in"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                RemoteImage(url: summary.title.posterURL, maxPixel: 200) {
                    PosterPlaceholder(name: summary.title.name)
                }
                .frame(width: 48, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(summary.title.name)
                        .font(Typeface.title(18))
                        .foregroundStyle(palette.ink)
                    Text(subtitle)
                        .font(Typeface.ui(12.5))
                        .foregroundStyle(palette.ink2)
                }
                Spacer()
                CodeBadge(code: summary.code) { together.copyChallengeCode(summary.code) }
                Menu {
                    Button("Copy code") { together.copyChallengeCode(summary.code) }
                    Button("Leave challenge") { together.leaveChallenge(summary.code) }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(palette.ink2)
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            if let state {
                VStack(spacing: 10) {
                    ForEach(Array(state.members.enumerated()), id: \.element.personId) { index, member in
                        RaceRow(
                            member: member, place: index + 1,
                            isMe: member.personId == together.personID,
                            isWinner: member.personId == state.winnerId,
                            myPet: app.session.pet.code
                        )
                    }
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(18)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// One person in a race: where they are, and how far.
private struct RaceRow: View {
    let member: ChallengeMember
    let place: Int
    let isMe: Bool
    let isWinner: Bool
    var myPet: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Text("\(place)")
                .font(Typeface.time(12, .semibold))
                .foregroundStyle(palette.ink3)
                .frame(width: 14, alignment: .trailing)
            PersonAvatar(name: member.name, petCode: isMe ? myPet : member.pet, isMe: isMe)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(isMe ? "\(member.name) (you)" : member.name)
                        .font(Typeface.ui(13, isMe ? .semibold : .medium))
                        .foregroundStyle(palette.ink)
                    if isWinner {
                        Image(systemName: "crown.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(palette.gold)
                            .accessibilityLabel("Winner")
                    }
                    Spacer()
                    Text(member.label)
                        .font(Typeface.ui(11.5))
                        .foregroundStyle(palette.ink3)
                        .lineLimit(1)
                }
                ProgressLine(fraction: member.fraction, height: isMe ? 5 : 4)
            }
        }
    }
}

// MARK: Shares

private struct SharesSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(name: "Share what you've watched")
            HStack(spacing: 12) {
                Button {
                    together.shareWatched()
                } label: {
                    Label("Share my Watched list", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(OutlineButtonStyle())
                .disabled(together.isWorking || app.library.watched.isEmpty)
                if let code = together.lastShareCode {
                    CodeBadge(code: code) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(ShareCode.display(code), forType: .string)
                        app.toasts.show("Code \(ShareCode.display(code)) copied")
                    }
                }
                Spacer()
            }
            Text(app.library.watched.isEmpty
                 ? "Films you mark as watched can go in a list for friends: posters and your ratings, nothing else."
                 : "\(app.library.watched.count) \(app.library.watched.count == 1 ? "film goes" : "films go") in, with their posters, your ratings and nothing else. A friend types the code and can add any of them to their backlog.")
                .font(Typeface.ui(12))
                .foregroundStyle(palette.ink3)
            ForEach(together.openedShares, id: \.code) { share in
                SharedList(share: share)
            }
        }
    }
}

private struct SharedList: View {
    let share: ShareInfo
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    private var together: TogetherModel { app.session.together }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(share.label)
                        .font(Typeface.title(17))
                        .foregroundStyle(palette.ink)
                    Text("From \(share.ownerName) · \(share.titles.count) \(share.titles.count == 1 ? "title" : "titles")")
                        .font(Typeface.ui(12))
                        .foregroundStyle(palette.ink3)
                }
                Spacer()
                Button("Close") { together.forgetShare(share.code) }
                    .buttonStyle(.plain)
                    .font(Typeface.ui(12))
                    .foregroundStyle(palette.ink2)
            }
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(share.titles, id: \.self) { card in
                        SharedPoster(card: card)
                    }
                }
            }
            .scrollIndicators(.never)
        }
        .padding(16)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct SharedPoster: View {
    let card: TitleCard
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var isHovered = false

    var body: some View {
        let have = app.session.together.hasInLibrary(card)
        VStack(alignment: .leading, spacing: 6) {
            Color.clear
                .frame(width: 96, height: 144)
                .overlay {
                    RemoteImage(url: card.posterURL, maxPixel: 300) { PosterPlaceholder(name: card.name) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if isHovered || have {
                        Button {
                            app.session.together.addToBacklog(card)
                        } label: {
                            Image(systemName: have ? "checkmark" : "plus")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(palette.onSilver)
                                .frame(width: 24, height: 24)
                                .background(Circle().fill(palette.silver))
                        }
                        .buttonStyle(.plain)
                        .padding(6)
                        .help(have ? "In your library" : "Add to backlog")
                        .disabled(have)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text(card.name)
                .font(Typeface.ui(11.5, .medium))
                .foregroundStyle(palette.ink2)
                .lineLimit(2)
                .frame(width: 96, alignment: .leading)
            if let rating = card.rating, rating > 0 {
                StarRow(halves: min(Rating.maxHalves, rating), size: 7.5, spacing: 0.5)
            }
        }
        .onHover { isHovered = $0 }
    }
}

// MARK: Pieces

private struct SectionHeading: View {
    let name: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(name)
            .font(Typeface.title(20))
            .foregroundStyle(palette.ink)
    }
}

/// The code to read out or paste, set like a ticket number.
struct CodeBadge: View {
    let code: String
    let copy: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: copy) {
            HStack(spacing: 6) {
                Text(ShareCode.display(code))
                    .font(Typeface.time(15, .semibold))
                    .tracking(1.5)
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 10.5))
                    .foregroundStyle(palette.ink3)
            }
            .foregroundStyle(palette.ink)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(palette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("Copy the code")
    }
}

/// A person, as their initial. The chrome has no colour, so neither do people: you are silver.
struct Avatar: View {
    let name: String
    var isMe = false
    var size: CGFloat = 26
    @Environment(\.palette) private var palette

    var body: some View {
        Text(String(name.prefix(1)).uppercased())
            .font(Typeface.bold(size * 0.46))
            .foregroundStyle(isMe ? palette.onSilver : palette.ink)
            .frame(width: size, height: size)
            .background(Circle().fill(isMe ? AnyShapeStyle(palette.silver) : AnyShapeStyle(palette.raised2)))
            .overlay(Circle().strokeBorder(palette.cardFill, lineWidth: 2))
    }
}
