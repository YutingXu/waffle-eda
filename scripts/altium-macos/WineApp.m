// Startup adapter for the x86_64 slice of this app. The kit's original Wine
// loader calls __wine_main. All Windows execution stays in the kit's ntdll.
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <os/log.h>
#import <stdio.h>
#import <stdlib.h>

void updateDesignerFileMenu(void);

static void displayProductIcon(void)
{
    if (!NSApp) return;
    static NSImage *icon;
    static NSImageView *view;
    NSDockTile *tile = NSApp.dockTile;
    if (view && tile.contentView == view) return;
    if (!view) {
        NSURL *url = [NSBundle.mainBundle URLForResource:@"AppIcon" withExtension:@"icns"];
        icon = [[NSImage alloc] initWithContentsOfURL:url];
        if (!icon) return;
        view = [[NSImageView alloc] initWithFrame:(NSRect){NSZeroPoint, tile.size}];
        view.image = icon;
        view.imageScaling = NSImageScaleProportionallyUpOrDown;
    }
    NSApp.applicationIconImage = icon;
    tile.contentView = view;
    [tile display];
    os_log(OS_LOG_DEFAULT, "Altium displayed the bundled icon in its Dock tile.");
}

__attribute__((visibility("default"))) void __wine_main(int argc, char **argv)
{
    void (*wineMain)(int, char **);
    @autoreleasepool {
        NSString *path = [NSBundle.mainBundle objectForInfoDictionaryKey:@"AltiumWineLibrary"];
        void *library = path ? dlopen(path.fileSystemRepresentation, RTLD_NOW) : NULL;
        wineMain = library ? dlsym(library, "__wine_main") : NULL;
        if (!wineMain) { fputs("The Altium Wine runtime is unavailable.\n", stderr); exit(1); }
        // Wine may select the full-bleed Windows icon when it creates its first
        // menu. Give the running Dock tile the same artwork as the pinned one.
        for (NSString *event in @[NSApplicationDidFinishLaunchingNotification,
                                  NSApplicationDidBecomeActiveNotification,
                                  NSWindowDidBecomeKeyNotification]) {
            [NSNotificationCenter.defaultCenter addObserverForName:event object:nil
                queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        displayProductIcon();
                        updateDesignerFileMenu();
                    });
                }];
        }
    }
    wineMain(argc, argv);
}
