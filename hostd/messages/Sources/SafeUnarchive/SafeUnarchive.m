#import "SafeUnarchive.h"

NSString *_Nullable StradPlainTextFromTypedStream(NSData *data) {
    // A typedstream starts with its version byte and "streamtyped". Anything
    // else is not handed to the unarchiver at all.
    static const char magic[] = "streamtyped";
    if (data.length < 13 || memcmp((const char *)data.bytes + 2, magic, 11) != 0) {
        return nil;
    }
    @try {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        // NSUnarchiver is deprecated, and it is still the only reader of the
        // format Messages writes this column in. The bytes come from Messages'
        // own database on this machine, not from the network.
        id object = [NSUnarchiver unarchiveObjectWithData:data];
#pragma clang diagnostic pop
        if ([object isKindOfClass:[NSAttributedString class]]) {
            return [(NSAttributedString *)object string];
        }
        if ([object isKindOfClass:[NSString class]]) {
            return (NSString *)object;
        }
        return nil;
    } @catch (NSException *exception) {
        return nil;
    }
}
