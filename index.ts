import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { minify as minifyjs } from "uglify-js";
import { minify as minifyhtml } from "@minify-html/node";

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
type MacImpl = (page:Page,dec:Dec) => Dec[];

type BuildParams = {
    sourcePaths?: {[namespace:string]: string};
    defaultSource?: string;

    sourceRoot?: {[namespace:string]: string};
    globalRoot?: string;
    
    outputPath?: string;
};

type Lib = {
    decorators?: {[name:string]: DecImpl};
    macros?: {[name:string]: MacImpl};
};

enum ParseState {
    Top,
    Namespace,
    Page,
};

class Source {
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
    private namespaces: Namespace[];
    private decorators: {[name:string]: DecImpl};
    private macros: {[name:string]: MacImpl};

    constructor () {
        this.namespaces = [];
        this.decorators = {};
        this.macros = {};
    }

    /**
     * Parses and adds a page declaration
     */
    public add( source: Source, props?: Props ) : this {
        const tokens: Token[] = tokenize(source);
    
        let state: ParseState = ParseState.Top;
        
        let namespace: Namespace|null = null;
        let page: Page|null = null;
    
        let decs: Dec[] = [];
        let groupDecs: Dec[] = [];
        let globDecs: Dec[] = [];
    
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
                        props: {...props} || {}
                    };
                    this.namespaces.push(namespace);
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
                    if (groupDecs.length) {
                        groupDecs = [];
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
                        decorators: [...globDecs,...groupDecs,...decs,],
                        props: {},
                    };
                    namespace.pages.push(page);
                    decs = [];
                }
                else if (token.val == '%') {
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
                else if (token.val == '{') {
                    if (!decs.length)
                        throw parseError(tokens[i].loc,'Expected decorators before group');
                    groupDecs = decs;
                    decs = [];
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

        return this;
    }

    /**
     * Adds a page declaration from a file
     */
    public addFile( path: string, props?: Props ) : this {
        return this.add(Source.fromFile(path),props);
    }

    /**
     * Adds a page declaration from a string input
     */
    public addText( text: string, name?: string, props?: Props ) : this {
        return this.add(new Source(name||'(input)',text),props);
    }
    
    /**
     * Adds a macro/decorator library to the pages builder
     */
    public use( lib: Lib ) : this {
        if (lib.decorators)
            Object.assign(this.decorators,lib.decorators);
        if (lib.macros)
            Object.assign(this.macros,lib.macros);
        return this;
    }

    /** 
     * Builds the pages, allowing to use *getPage*
     */
    public build( params: BuildParams ) : this {
        for (const namespace of this.namespaces) {
            for (const page of namespace.pages) {
                for (const macro of page.decorators.filter(dec=>dec.props.__mac)) {
                    const impl = this.macros[macro.name];
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
                    const impl = this.decorators[dec.name];
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
                    const proot = namespace.props.source||((params.sourcePaths||{})[namespace.name])||params.defaultSource;
                    if (!proot)
                        throw buildError(namespace.loc,`Missing source directory for \`${page.name}\``);
                    const p = path.join((params.sourceRoot||{})[namespace.name]||params.globalRoot||'',proot,page.path);
                    if (!fs.existsSync(p))
                        throw buildError(page.loc,`File \`${p}\` could not be found`);
                    let body = fs.readFileSync(p,'utf-8');
                    for (const proc of page.props.__process || [])
                        body = proc(body);
                    fs.writeFileSync(path.join(dest,page.path),body,'utf-8');
                    let root: string = namespace.props.root || '/';
                    page.name = (root.replace(/(^\/)|(\/$)/g,'')+'/'+page.name.replace(/(^\/)|(\/$)/g,'')).replace(/(^\/)/g,'');
                    page.path = path.resolve(path.join(dest,page.path));
                }
            }
        }

        return this;
    }

    /**
     * Attempts to retreive a page from its path (best used afer *build*)
     */
    public getPage( path: string ) : {body:string,page:Page}|null {
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

export const builtinLib : Lib = {
    decorators : {
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
                (page.props.__process ||= []).push((body:string) => {
                    const min = minifyjs(body,{});
                    return min.code;
                });
            if (page.path.endsWith('.html'))
                (page.props.__process ||= []).push((body:string) => {
                    const min = minifyhtml(
                        Buffer.from(body),
                        {
                            minify_css: true,
                            minify_js: true,
                            keep_comments: false,
                            do_not_minify_doctype: true
                        }
                    ).toString('utf-8');
                    return min;
                });
        }
    },
    macros : {
        'auto' : (page,dec) => {
            return [
                { name: 'kind', args: [], props: {}, loc: dec.loc },
                { name: 'min', args: [], props: {}, loc: dec.loc }
            ];
        }
    }
};