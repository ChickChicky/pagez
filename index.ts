import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { minify as minifyjs } from "uglify-js";
import { minify as minifyhtml } from "html-minifier";

type Props = {[name:string]:any};

type Dec = {
    loc: Loc;
    name: string;
    props: Props;
    args: any[];
};

type Page = {
    loc: Loc;
    name: string,
    path?: string;
    props: Props;
    decorators: Dec[];
};

type Namespace = {
    loc: Loc;
    name: string;
    props: Props;
    pages: Page[];
};

type DecImpl = (page:Page,dec:Dec) => void;

type BuildParams = {
    decorators: {[name:string]: DecImpl},
    macros: {[name:string]: (page:Page,dec:Dec) => Dec[]},
    paths?: {[namespace:string]: string},
    sourcePath: string,
    defaultPath?: string,
    outputPath?: string,
};

enum ParseState {
    Top,
    Namespace,
    Page,
};

enum DecState {
    Pending,
    Group,
};

export class Source {
    name: string;
    body: string;

    constructor (name:string, body:string) {
        this.name = name;
        this.body = body.replace(/\r\n/g,'\n');
    }

    static fromFile(path:string) : Source {
        const body: string = fs.readFileSync(path,'utf-8');
        return new Source(path,body);
    }
}

class Loc {
    src: Source;
    col: number;
    row: number;
    len: number;

    constructor (src:Source, col:number, row:number, len:number) {
        this.src = src;
        this.col = col;
        this.row = row;
        this.len = len;
    }

    [inspect.custom]() {
        return `\x1b[36m${this.src.name}:${this.row+1}:${this.col+1}\x1b[39m`;
    }
}

class Token {
    val: string;
    loc: Loc;
    
    constructor (col:number, row:number, val:string, src:Source) {
        this.val = val;
        this.loc = new Loc(src,col,row,val.length);
    }

    isNamespace() : boolean {
        return this.val.startsWith('(') && this.val.endsWith(')');
    }

    isPage() : boolean {
        return this.val.startsWith('[') && this.val.endsWith(']');
    }

    isIdentifier() : boolean {
        return /^#?[a-z0-9_\-]+$/i.test(this.val);
    }

    isString() : boolean {
        return this.val.startsWith('"') && this.val.endsWith('"');
    }
}

class EOF extends Token {
    constructor (col:number, row:number, src:Source) {
        super(col,row,' ',src);
    }
}

export class Pages {
    namespaces: Namespace[];

    constructor (namespaces: Namespace[]) {
        this.namespaces = namespaces;
    }

    /** 
     * Builds the pages, allowing to use *getPage*
     */
    build( params: BuildParams ) {
        for (const namespace of this.namespaces) {
            for (const page of namespace.pages) {
                for (const macro of page.decorators.filter(dec=>dec.props.__mac)) {
                    const impl = params.macros[macro.name];
                    if (!impl)
                        throw buildError(macro.loc,`Unknown macro \`${macro.name}\``);
                    const decs = impl(page,macro);
                    if (macro.props.__not) {
                        for (const dec of decs) {
                            dec.props.__not = true;
                        }
                    }
                    page.decorators.splice(page.decorators.indexOf(macro),1,...decs);
                }
                for (let i = page.decorators.length-1; i >= 0; i--) {
                    const dec = page.decorators[i];
                    if (!dec.props.__not) continue;
                    for (let j = page.decorators.length-1; j >= i; j--) {
                        if (page.decorators[j].name == dec.name) {
                            page.decorators.splice(j,1);
                        }
                    }
                }
                for (const dec of page.decorators) {
                    const impl = params.decorators[dec.name];
                    if (!impl)
                        throw buildError(dec.loc,`Unknown decorator \`${dec.name}\``);
                    impl(page,dec);
                }
                page.decorators = [];
            }
        }
        if (params.outputPath) {
            if (!fs.existsSync(params.outputPath))
                fs.mkdirSync(params.outputPath);
            else if (fs.statSync(params.outputPath).isFile())
                throw EvalError(`Output path (\`${params.outputPath}\`) is a file`);
            for (const namespace of this.namespaces) {
                const dest = path.join(params.outputPath,namespace.name);
                if (!fs.existsSync(dest))
                    fs.mkdirSync(dest);
                else if (fs.statSync(dest).isFile())
                    throw EvalError(`Output path for ${namespace.name} (\`${dest}\`) is a file`);
                for (const page of namespace.pages) {
                    if (!page.path)
                        throw buildError(page.loc,`Missing path of the page`);
                    const p = path.join(params.sourcePath+((params.paths||{})[namespace.name]||params.defaultPath||''),page.path);
                    if (!fs.existsSync(p))
                        throw buildError(page.loc,`File \`${p}\` could not be found`);
                    let body = fs.readFileSync(p,'utf-8');
                    if (page.props.__process)
                        body = page.props.__process(body);
                    fs.writeFileSync(path.join(dest,page.path),body,'utf-8');
                    let root: string = namespace.props.root || '/';
                    page.name = (root.replace(/(^\/)|(\/$)/g,'')+'/'+page.name.replace(/(^\/)|(\/$)/g,'')).replace(/(^\/)/g,'');
                    page.path = path.resolve(path.join(dest,page.path));
                }
            }
        }
    }

    /**
     * Attempts to retreive a page from its path (best used afer *build*)
     */
    getPage( path: string ) : {body:string,page:Page}|null {
        path = path.replace(/(^\/)|(\/$)/g,'');
        for (const namespace of this.namespaces) {
            for (const page of namespace.pages) {
                if (page.name == path && page.path)
                    return {body:fs.readFileSync(page.path,'utf-8'),page};
            }
        }
        return null;
    }
}

function parseError( loc:Loc, message:string, hint?:string ) {
    const trueline = loc.src.body.split(/\n/g)[loc.row];
    const line = trueline.replace(/^\s+/g,'').replace(/\s+$/g,'');
    const col = loc.col - trueline.length + line.length;
    return SyntaxError(
        `\x1b[31;1m${message}\x1b[39;22m \x1b[90m@ ${loc.src.name}:${loc.row+1}:${loc.col+1}\x1b[39m\n` +
        `    ${line}\n`+
        `    ${' '.repeat(col)}\x1b[33m${'^'.repeat(loc.len)}\x1b[39m` +
        ( hint ? `\nHint: ${hint}` : '' )
    );
}

function buildError( loc:Loc, message:string, hint?:string ) {
    const trueline = loc.src.body.split(/\n/g)[loc.row];
    const line = trueline.replace(/^\s+/g,'').replace(/\s+$/g,'');
    const col = loc.col - trueline.length + line.length;
    return EvalError(
        `\x1b[31;1m${message}\x1b[39;22m \x1b[90m@ ${loc.src.name}:${loc.row+1}:${loc.col+1}\x1b[39m\n` +
        `    ${line}\n`+
        `    ${' '.repeat(col)}\x1b[33m${'^'.repeat(loc.len)}\x1b[39m` +
        ( hint ? `\nHint: ${hint}` : '' )
    );
}

function resolveValue( token:Token ) : any {
    if (token instanceof EOF) {
        throw parseError(token.loc,'Expected an expression');
    }
    if (token.isString()) {
        return token.val.slice(1,-1);
    }
    if (token.isIdentifier())
        throw parseError(token.loc,'Variables are not supported yet');
    throw parseError(token.loc,'Invalid value');
}

function tokenize( source: Source ) : Token[] {
    const tokens: Token[] = [];

    let t: string = '';

    let col: number = 0;
    let row: number = 0;

    function pushtk(tk:string) {
        tokens.push(new Token(col-Math.max(0,tk.length-1),row,tk,source));
    }

    function pushtoken(tt:string='') {
        if (t)
            pushtk(t+tt);
        t = '';
    }

    for (let i = 0; i < source.body.length; i++) {
        const chr: string = source.body[i];

        if (t[0] == '"') {
            if (chr == '"') {
                pushtoken(chr);
            } else {
                t += chr;
            }
        } else if (t[0] == '[') {
            if (chr == ']') {
                pushtoken(chr);
            } else {
                t += chr;
            }
        }  else if (t[0] == '(') {
            if (chr == ')') {
                pushtoken(chr);
            } else {
                t += chr;
            }
        } else {
            if (/[!=\-!@%{}<>]/.test(chr)) {
                pushtoken();
                pushtk(chr);
            }
            else if (/\s/.test(chr)) {
                col--;
                pushtoken();
                col++;
            }
            else {
                t += chr;
            }
        }

        if (chr == '\n') {
            col = 0;
            row++;
        } else {
            col++;
        }
    }

    pushtoken();

    tokens.push(new EOF(col,row,source));

    return tokens;
}

export function parse( source: Source ) : Pages {
    const namespaces: Namespace[] = [];
    const tokens: Token[] = tokenize(source);

    let state: ParseState = ParseState.Top;
    
    let namespace: Namespace|null = null;
    let page: Page|null = null;

    let decs: Dec[] = [];
    let globDecs: Dec[] = [];
    let decState: DecState = DecState.Pending;

    for (let i = 0; i < tokens.length; i++) {
        const token: Token = tokens[i];
        
        if (state == ParseState.Top) {
            if (token.isNamespace()) {
                const name: string = token.val.slice(1,-1);
                if (!name.length) {
                    throw parseError(token.loc,'Missing namespace name');
                }
                if (tokens[i+1].val != '{') {
                    throw parseError(tokens[i+1].loc,'Expected `{`');
                }
                i++;
                state = ParseState.Namespace;
                namespace = {
                    name,
                    loc: token.loc,
                    pages: [],
                    props: {}
                };
                namespaces.push(namespace);
            } 
            else if (token instanceof EOF) {
                break;
            } 
            else {
                throw parseError(token.loc,'Expected a namespace declaration',token.isIdentifier()?`Maybe you meant \`(${token.val})\`?`:'');
            }
        }

        else if (state == ParseState.Namespace) {
            if (!namespace) throw parseError(token.loc,'<INVALID STATE>');
            if (token.val == '}') {
                if (decState == DecState.Group) {
                    decState = DecState.Pending;
                    decs = [];
                } else {
                    state = ParseState.Top;
                    namespace = null;
                }
            }
            else if (token.isIdentifier()) {
                if (tokens[i+1].val != '=') {
                    throw parseError(tokens[i+1].loc,'Expected `=`');
                }
                const name: string = token.val;
                const value: any = resolveValue(tokens[i+2]);
                namespace.props[name] = value;
                i += 2;
            }
            else if (token.isPage()) {
                const name = token.val.slice(1,-1);
                if (tokens[i+1].val != '{') {
                    throw parseError(tokens[i+1].loc,'Expected `{`');
                }
                i++;
                state = ParseState.Page;
                page = {
                    name,
                    loc: token.loc,
                    decorators: [...decs,...globDecs],
                    props: {},
                };
                namespace.pages.push(page);
                if (decState == DecState.Pending)
                    decs = [];
            }
            else if (token.val == '%') {
                if (decState == DecState.Group)
                    throw parseError(tokens[i].loc,'Decorators are not allowed within a group');
                i++;
                let not = false;
                let mac = false;
                let glb = false;
                if (tokens[i].val == '%') {
                    glb = true;
                    i++;
                }
                if (tokens[i].val == '-') {
                    not = true;
                    i++;
                }
                if (tokens[i].val == '!') {
                    mac = true;
                    i++;
                }
                if (!tokens[i].isIdentifier()) {
                    throw parseError(tokens[i].loc,'Expected an identifier');
                }
                const name: string = tokens[i].val;
                const dec: Dec = {
                    name,
                    loc: token.loc,
                    args: [],
                    props: {}
                };
                if (glb)
                    globDecs.push(dec);
                else
                    decs.push(dec);
                if (not) dec.props.__not = true;
                if (mac) dec.props.__mac = true;
                if (glb) dec.props.__glb = true;
                if (tokens[i+1].val == '<') {
                    if (not)
                        throw parseError(tokens[i+1].loc,'Can\'t add parameters to cancelled decorator');
                    i++;
                    while (tokens[++i].val != '>') {
                        if (tokens[i].isIdentifier()) {
                            const name = tokens[i++].val;
                            if (tokens[i++].val != '=') {
                                throw parseError(tokens[i-1].loc,'Expected `=`');
                            }
                            const value = resolveValue(tokens[i]);
                            dec.props[name] = value;
                        }
                        else {
                            const value = resolveValue(tokens[i]);
                            dec.args.push(value);
                        }
                    }
                }
            }
            else if (token.val == '{' && decs.length) {
                decState = DecState.Group;
            }
            else if (token.isNamespace()) {
                throw parseError(token.loc,'Unexpected namespace declaration');
            }
            else if (token instanceof EOF) {
                throw parseError(token.loc,'Unexpected EOF');
            } 
            else {
                throw parseError(token.loc,'Unexpected token');
            }
        }

        else if (state == ParseState.Page) {
            if (!page) throw parseError(token.loc,'<INVALID STATE>');
            if (token.val == '}') {
                state = ParseState.Namespace;
                page = null;
            }
            else if (token.isIdentifier()) {
                if (tokens[i+1].val != '=') {
                    throw parseError(tokens[i+1].loc,'Expected `=`');
                }
                const name = token.val;
                const value = resolveValue(tokens[i+2]);
                page.props[name] = value;
                i += 2;
            }
            else if (token.val == '@') {
                i++;
                if (!tokens[i].isString()) {
                    throw parseError(tokens[i].loc,'Expected a string for page path');
                }
                page.path = tokens[i].val.slice(1,-1);
            }
            else if (token.isNamespace()) {
                throw parseError(token.loc,'Unexpected namespace declaration');
            }
            else if (token.isPage()) {
                throw parseError(token.loc,'Unexpected page declaration');
            }
            else {
                throw parseError(token.loc,'Unexpected token');
            }
        }
    }

    return new Pages(namespaces);
}

export const builtinDecorators: {[name:string]: DecImpl} = {
    'kind' : (page,dec) => {
        if (dec.props.kind || dec.args[0]) {
            (page.props.__headers ||= {})['Content-Type'] = dec.props.kind || dec.args[0];
        } else {
            let kind: string|null = null;

            if (page.name.endsWith('.js'))
                kind = 'application/javascript';
            else if (page.name.endsWith('.css'))
                kind = 'text/css';
            else if (page.name.endsWith('.html'))
                kind = 'text/html';

            if (kind)
                (page.props.__headers ||= {})['Content-Type'] = kind;
        }
    },
    'min' : (page,dec) => {
        if (!page.path) return;
        if (page.path.endsWith('.js'))
            page.props.__process = (body:string) => {
                const min = minifyjs(body,{});
                return min.code;
            };
        if (page.path.endsWith('.html'))
            page.props.__process = (body:string) => {
                const min = minifyhtml(body,{
                    collapseWhitespace: true,
                    collapseInlineTagWhitespace: true,
                    minifyCSS: true,
                    minifyJS: true,
                    removeComments: true,
                    removeEmptyAttributes: true,
                    removeRedundantAttributes: true,
                    decodeEntities: true,
                    keepClosingSlash: false,
                    removeScriptTypeAttributes: true,
                    removeStyleLinkTypeAttributes: true
                });
                return min;
            };
    }
};

export const builtinMacros: {[name:string]: (page:Page,dec:Dec) => Dec[]} = {
    'auto' : (page,dec) => {
        return [
            { name: 'kind', args: [], props: {}, loc: dec.loc },
            { name: 'min', args: [], props: {}, loc: dec.loc }
        ];
    }
};