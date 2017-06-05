export function lineAndColumn(content, index) {
    let prefix = content.substring(0, index);
    let line = prefix.split(/\n/).length;
    let column = prefix.length - prefix.lastIndexOf("\n");

    return [line, column];
}

function selfClosing(tagName) {
    return ["br", "hr", "input", "img", "link", "meta"].includes(tagName);
}

function rx(text) {
    return text.replace(/\s*#[^\n]*/g, "").replace(/\s+/g, "");
}

function removeCaptures(text) {
    return text.replace(/\((?!\?)/g, "(?:");
}

function by(prop) {
    return (a, b) => prop(a) < prop(b)
        ? -1
        : prop(a) > prop(b)
            ? +1
            : 0;
}

let ATTRIBUTE = rx(`
    \\s+ ([\\w\\-]+)    # attribute name
    (?:                 # attribute value
        (?: =' ([^']*) ' ) |
        (?: =" ([^"]*) " ) |
        (?: =\\{\\{ ((?:(?!\\}\\}).)*) \\}\\} )
    )?
`);

let OPENING_TAG_PATTERN = rx(`
    ^<
    ([\\w\\-]+)         # tag name
    (
        (?: ${removeCaptures(ATTRIBUTE)} )*
    )
    \\s*
    (/ \\s*)?
    >
`);

let CONTROLLER = "controller";
let AMBIENT = "ambient";
let LABEL = "label";

export function parseTemplate(content, fileName, options = {}) {
    let idUsedBy = {};
    let idRegExp = /#([\w\-]+)/g;
    let getElementByIdRegExp = /\bgetElementById\(['"]([\w-]+)/g;
    let byIdRegExp = /\bby\.id\(['"]([\w-]+)/g;

    {
        let idMatch;
        while ((idMatch = idRegExp.exec(options.controllerSource))) {
            let id = idMatch[1];
            idUsedBy[id] = CONTROLLER;
        }

        while ((idMatch = getElementByIdRegExp.exec(options.controllerSource))) {
            let id = idMatch[1];
            idUsedBy[id] = CONTROLLER;
        }

        while ((idMatch = idRegExp.exec(options.ambientSource))) {
            let id = idMatch[1];
            idUsedBy[id] = AMBIENT;
        }

        while ((idMatch = getElementByIdRegExp.exec(options.ambientSource))) {
            let id = idMatch[1];
            idUsedBy[id] = AMBIENT;
        }

        while ((idMatch = byIdRegExp.exec(options.ambientSource))) {
            let id = idMatch[1];
            idUsedBy[id] = AMBIENT;
        }
    }

    let classUsedBy = {};
    let classRegExp = /\.([\w\-]+)/g;

    {
        let classMatch;
        while ((classMatch = classRegExp.exec(options.controllerSource))) {
            let className = classMatch[1];
            classUsedBy[className] = CONTROLLER;
        }

        while ((classMatch = classRegExp.exec(options.ambientSource))) {
            let className = classMatch[1];
            classUsedBy[className] = AMBIENT;
        }
    }

    let errors = [];

    let pos = 0;
    let tagStack = [];
    let seenId = {};
    let idCheckQueue = [];
    let seenClass = {};

    function registerError(message, hint = "", customPos = pos) {
        let [line, column] = lineAndColumn(content, customPos);
        errors.push(hint
            ? { message, fileName, line, column, hint }
            : { message, fileName, line, column });
    }

    function checkNamingConvention(name, thingType, customPos) {
        if (!/^[a-z\d]+(?:\-[a-z\d]+)*$/.test(name)) {
            let suggestedName = name
                .replace(/_/g, "-")
                .replace(/^[A-Z]/, (letter) => letter.toLowerCase())
                .replace(/-[A-Z]/g, (dashLetter) => dashLetter.toLowerCase())
                .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
            registerError(
                `The ${thingType} '${name}' does not conform to naming guidelines (all-lowercase, hyphens)`,
                `Suggest writing it as '${suggestedName}' instead`,
                customPos
            );
        }
    }

    while (pos < content.length) {
        let suffix = content.substring(pos);

        let directiveMatch = suffix.match(/^<!\w+\s(?:[^>]*)>/);
        let mismatchedCommentOpenerMatch = suffix.match(/^<!--(?:(?!-->)[\s\S])*$/);
        let mismatchedCommentCloserMatch = suffix.match(/^-->/);
        let strayCommentOpenerInComment = suffix.match(/^<!--(?:(?!-->)(?!<!--)[\s\S])*<!--/);
        let commentMatch = suffix.match(/^<!--(?:(?!-->)(?!<!--)[\s\S])*-->/);
        let textMatch = suffix.match(/^(?:(?!<)(?!\{\{)(?!-->)[\s\S])+/);
        let angularExpressionMatch = suffix.match(/^\{\{((?:(?!\}\})[\s\S])*)\}\}/);
        let skipMatch = directiveMatch || commentMatch || angularExpressionMatch;

        let openingTagMatch = suffix.match(new RegExp(OPENING_TAG_PATTERN));
        let closingTagMatch = suffix.match(/^<\/(\w+(?:-\w+)*)(--)?>/);

        if (skipMatch) {
            let [{ length }] = skipMatch;
            pos += length;
        } else if (textMatch) {
            let [text] = textMatch;
            let { length } = text;
            let bareAmpersandRegExp = /\&(?!amp;)/g;
            let bareAmpersandMatch;
            while ((bareAmpersandMatch = bareAmpersandRegExp.exec(text))) {
                registerError(
                    "Got bare ampersand ('&') in text",
                    "Need to escape ampersands as '&amp;'",
                    pos + bareAmpersandMatch.index
                );
            }
            pos += length;
        } else if (openingTagMatch) {
            let [{ length }, tagName, attributes, selfClosingSlash] = openingTagMatch;
            let [line, column] = lineAndColumn(content, pos);
            if (!selfClosing(tagName)) {
                tagStack.push({ expectedTagName: tagName, line, column });
            }
            let tagPrefixMatch = suffix.match(/^<[\w\-]+/);
            let tagPrefixLength = tagPrefixMatch[0].length;
            let attributeRegExp = new RegExp(ATTRIBUTE, "g");
            let attributeMatch;
            while ((attributeMatch = attributeRegExp.exec(attributes))) {
                let [attribute, attributeName, singleQuote, doubleQuote, doubleCurly] = attributeMatch;
                let attributeValue = singleQuote || doubleQuote || doubleCurly || "";
                let attributeOffset = attributeMatch.index + attribute.match(/^\s*/)[0].length;
                let attributePos = pos + tagPrefixLength + attributeOffset;

                if (doubleCurly) {
                    registerError(
                        `Unquoted template expression in attribute value: {{${doubleCurly}}}`,
                        "",
                        attributePos + attributeName.length + 1
                    );
                } else if (attributeName === "id") {
                    let id = attributeValue;
                    if (seenId.hasOwnProperty(id)) {
                        let { line, column } = seenId[id];
                        let hint = `First occurrence at line ${line}, column ${column}`;
                        registerError(`Duplicate ID '${id}'`, hint, attributePos);
                    } else {
                        let [line, column] = lineAndColumn(content, attributePos);
                        seenId[id] = { line, column };
                        if (!idUsedBy[id]) {
                            idCheckQueue.push({ id, attributePos });
                        }
                        if (idUsedBy[id] !== AMBIENT) {
                            checkNamingConvention(id, "ID", attributePos);
                        }
                    }
                } else if (tagName === "label" && attributeName === "for") {
                    idUsedBy[attributeValue] = LABEL;
                } else if (attributeName === "class" && !attributeValue.match(/\{\{/)) {
                    let wordRegExp = /(\S+)/g;
                    let wordMatch;
                    while ((wordMatch = wordRegExp.exec(attributeValue))) {
                        let className = wordMatch[1];
                        if (!seenClass.hasOwnProperty(className)) {
                            let [line, column] = lineAndColumn(content, attributePos);
                            seenClass[className] = { line, column };
                            if (!classUsedBy[className]) {
                                registerError(`Unused class '${className}'`, "", attributePos);
                            }
                            if (classUsedBy[className] !== AMBIENT) {
                                checkNamingConvention(className, "class", attributePos);
                            }
                        }
                    }
                }
            }

            if (selfClosingSlash) {
                let selfClosingSlashPos = pos + openingTagMatch[0].lastIndexOf("/");
                registerError(
                    `XHTML-wannabe slash at the end of <${tagName}> element tag`,
                    "See http://stackoverflow.com/questions/3558119/are-non-void-self-closing-tags-valid-in-html5",
                    selfClosingSlashPos
                );
            }
            pos += length;
        } else if (closingTagMatch) {
            let [{ length }, tagName, mismatchedClosingComment] = closingTagMatch;
            if (mismatchedClosingComment) {
                let closerPos = pos + length - 3;
                registerError(`Mismatched HTML comment closer in closing tag ('</${tagName} -->')`, "", closerPos);
                return errors;
            } else if (!tagStack.length) {
                registerError(`Got </${tagName}> without <${tagName}>`);
            } else {
                let { expectedTagName, line, column } = tagStack.pop();
                while (tagName !== expectedTagName) {
                    let hint = `Mismatched opening <${expectedTagName}> at line ${line}, column ${column}`;
                    registerError(`Got </${tagName}> before the expected </${expectedTagName}>`, hint);
                    if (!tagStack.length) {
                        registerError(`Got </${tagName}> without <${tagName}>`);
                        break;
                    } else {
                        ({ expectedTagName, line, column } = tagStack.pop());
                    }
                }
            }
            pos += length;
        } else if (mismatchedCommentOpenerMatch) {
            registerError("Mismatched HTML comment opener (`<!--`)");
            return errors;
        } else if (mismatchedCommentCloserMatch) {
            registerError("Mismatched HTML comment closer (`-->`)");
            return errors;
        } else if (strayCommentOpenerInComment) {
            let [{ length }] = strayCommentOpenerInComment;
            let strayOpenerPos = pos + length - 4;
            registerError("HTML comment opener (`<!--`) inside HTML comment", "", strayOpenerPos);
            return errors;
        } else {
            let unknown = suffix.substring(0, 15).replace(/\n/g, "\\n").replace(/\r/g, "\\r");
            let [line, column] = lineAndColumn(content, pos);
            let message = `Unknown thing "${unknown}"` + "\n" +
                `Don't know how to proceed at line ${line}, column ${column} of file ${fileName}`;
            throw new Error(message);
        }
    }

    if (tagStack.length) {
        let { expectedTagName, line, column } = tagStack.pop();
        let hint = `Mismatched opening <${expectedTagName}> at line ${line}, column ${column}`;
        registerError(`Got end of template before the expected </${expectedTagName}>`, hint);
    }

    for (let { id, attributePos } of idCheckQueue) {
        if (!idUsedBy[id]) {
            registerError(`Unused ID '${id}'`, "", attributePos);
        }
    }

    return errors
        .sort(by((error) => error.column))
        .sort(by((error) => error.line));
}
