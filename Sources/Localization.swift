import Combine
import Foundation

enum AppLanguage: String, CaseIterable, Identifiable {
    case english = "en"
    case spanish = "es"
    case portuguese = "pt"
    case french = "fr"
    case german = "de"
    case japanese = "ja"
    case simplifiedChinese = "zh-Hans"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .english: return "English"
        case .spanish: return "Español"
        case .portuguese: return "Português"
        case .french: return "Français"
        case .german: return "Deutsch"
        case .japanese: return "日本語"
        case .simplifiedChinese: return "简体中文"
        }
    }
}

struct InterfaceStrings {
    let locale: Locale
    private let primary: Bundle?
    private let english: Bundle?

    init(language: AppLanguage, resources: Bundle) {
        locale = Locale(identifier: language.rawValue)
        func bundle(for language: AppLanguage) -> Bundle? {
            resources.url(forResource: language.rawValue, withExtension: "lproj").flatMap(Bundle.init(url:))
        }
        english = bundle(for: .english)
        primary = language == .english ? english : bundle(for: language)
    }

    func optional(_ key: String) -> String? {
        for bundle in [primary, english] {
            if let value = bundle?.localizedString(forKey: key, value: nil, table: nil), value != key, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func callAsFunction(_ key: String, _ arguments: CVarArg...) -> String {
        let value = optional(key) ?? key
        return arguments.isEmpty ? value : String(format: value, locale: locale, arguments: arguments)
    }

    func status(_ state: String) -> String {
        optional("status." + state) ?? self("status.loading")
    }
}

@MainActor
final class InterfaceLanguage: ObservableObject {
    @Published private(set) var selection: AppLanguage
    private let defaults: UserDefaults
    private let translations: [AppLanguage: InterfaceStrings]
    private static let preference = "interfaceLanguage"

    init(defaults: UserDefaults = .standard, resources: Bundle = .main) {
        self.defaults = defaults
        selection = defaults.string(forKey: Self.preference).flatMap(AppLanguage.init(rawValue:)) ?? .english
        translations = Dictionary(uniqueKeysWithValues: AppLanguage.allCases.map {
            ($0, InterfaceStrings(language: $0, resources: resources))
        })
    }

    func select(_ language: AppLanguage) {
        guard selection != language else { return }
        defaults.set(language.rawValue, forKey: Self.preference)
        selection = language
    }

    var strings: InterfaceStrings { strings(for: selection) }

    func strings(for language: AppLanguage) -> InterfaceStrings { translations[language]! }
}
