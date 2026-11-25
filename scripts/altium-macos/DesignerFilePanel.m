#import <AppKit/AppKit.h>
#import <notify.h>
#import <os/log.h>

@interface DesignerFilePanel : NSObject
@property(nonatomic, strong) NSOpenPanel *panel;
- (void)choose:(id)sender;
@end

@implementation DesignerFilePanel
- (void)choose:(id)sender
{
    if (self.panel) {
        [self.panel makeKeyAndOrderFront:nil];
        return;
    }
    NSWindow *owner = NSApp.mainWindow ?: NSApp.keyWindow;
    if (!owner.isVisible || owner.attachedSheet || NSApp.modalWindow) return;
    NSString *helper = [NSBundle.mainBundle objectForInfoDictionaryKey:@"AltiumFileOpener"];
    if (![NSFileManager.defaultManager fileExistsAtPath:helper]) return;

    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"Choose Document to Open";
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = YES;
    panel.directoryURL = [NSUserDefaults.standardUserDefaults URLForKey:@"AltiumLastOpenFolder"]
        ?: [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
    self.panel = panel;
    [panel beginSheetModalForWindow:owner completionHandler:^(NSModalResponse result) {
        self.panel = nil;
        if (result != NSModalResponseOK || !panel.URLs.count) return;
        if (panel.directoryURL)
            [NSUserDefaults.standardUserDefaults setURL:panel.directoryURL forKey:@"AltiumLastOpenFolder"];
        NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
        config.activates = NO;
        [NSWorkspace.sharedWorkspace openURLs:panel.URLs
                        withApplicationAtURL:[NSURL fileURLWithPath:helper]
                               configuration:config
                           completionHandler:^(NSRunningApplication *app, NSError *error) {
            if (error) dispatch_async(dispatch_get_main_queue(), ^{
                [[NSAlert alertWithError:error] beginSheetModalForWindow:owner completionHandler:nil];
            });
        }];
    }];
    os_log(OS_LOG_DEFAULT, "Altium presented its macOS Open sheet.");
}
@end

void updateDesignerFileMenu(void)
{
    if (NSApp.activationPolicy != NSApplicationActivationPolicyRegular || !NSApp.mainMenu.numberOfItems) return;
    static DesignerFilePanel *controller;
    static NSMenuItem *fileMenu;
    if (!controller) {
        controller = [DesignerFilePanel new];
        // The two Altium Open commands post this prefix-specific event. Only an
        // interactive Wine window installs the receiver. File paths never enter it.
        NSString *name = [NSBundle.mainBundle objectForInfoDictionaryKey:@"AltiumOpenNotification"];
        int token;
        if (name.length)
            notify_register_dispatch(name.UTF8String, &token, dispatch_get_main_queue(), ^(int ignored) {
                [controller choose:nil];
            });
        fileMenu = [[NSMenuItem alloc] initWithTitle:@"File" action:NULL keyEquivalent:@""];
        NSMenu *menu = [[NSMenu alloc] initWithTitle:@"File"];
        fileMenu.submenu = menu;
        NSMenuItem *open = [menu addItemWithTitle:@"Open…" action:@selector(choose:) keyEquivalent:@"o"];
        open.target = controller;
        open.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    }
    if (fileMenu.menu != NSApp.mainMenu) {
        [fileMenu.menu removeItem:fileMenu];
        [NSApp.mainMenu insertItem:fileMenu atIndex:1];
    }
}
