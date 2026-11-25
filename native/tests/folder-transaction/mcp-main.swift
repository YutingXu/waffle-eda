import Foundation

@main
struct MCPFolderTestHost {
    static func main() {
        let environment = ProcessInfo.processInfo.environment
        let selected = CommandLine.arguments[2]
        exit(runFolderMCP(selected) { point, _ in
            if point == environment["WAFFLE_TEST_KILL_FOLDER_AT"] { exit(97) }
            if point == environment["WAFFLE_TEST_PAUSE_FOLDER_AT"], let gate = environment["WAFFLE_TEST_FOLDER_GATE"] {
                try Data().write(to:URL(fileURLWithPath:gate+".ready"))
                let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000
                while !FileManager.default.fileExists(atPath:gate+".resume") {
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw FolderFailure("The test gate timed out.") }
                    Thread.sleep(forTimeInterval:0.002)
                }
            }
            if point == "before-publish", let target = environment["WAFFLE_TEST_CHANGED_OWNER"],
               let bytes = environment["WAFFLE_TEST_CHANGED_BYTES"], let data = Data(base64Encoded:bytes) {
                try data.write(to:URL(fileURLWithPath:target), options:.atomic)
            }
        })
    }
}
