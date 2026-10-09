#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The plain text of a Messages `attributedBody`: an NSAttributedString
/// archived as a typedstream (the pre-NSKeyedArchiver format). Nil when the
/// data is not one, or is damaged. Never raises.
NSString *_Nullable StradPlainTextFromTypedStream(NSData *data);

NS_ASSUME_NONNULL_END
