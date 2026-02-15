import SwiftUI

struct AutoGrowingTextField: View {
    @Binding var text: String
    var placeholder: String
    var onSubmit: () -> Void

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...6)
            .font(.body)
            .onSubmit {
                onSubmit()
            }
            .padding(10)
            .background(Color.gray.opacity(0.12))
            .cornerRadius(12)
    }
}
