//var assert = require("assert").ok;
var Cast = require("cast.js");
var Class = require("rtl.js").Class;
var Code = require("code.js");
var Errors = require("errors.js");
var precedence = require("operator.js").precedence;
var Type = require("type.js");

var Arg = Class.extend({
	init: function(type, isVar){
		this.type = type;
		this.isVar = isVar;
	},
	description: function(){
		return (this.isVar ? "VAR " : "") + this.type.description();
	}
});
exports.Arg = Arg;

var CheckArgumentResult = Arg.extend({
	init: function(type, isVar, convert){
		Arg.prototype.init.call(this, type, isVar);
		this.convert = convert;
	}
});

var ProcCallGenerator = Class.extend({
	init: function ProcCallGenerator(context, id, type){
		this.__context = context;
		this.__id = id;
		this.__type = type;
		this.__argumentsCount = 0;
		this.__code = new Code.SimpleGenerator();
		this.writeCode(this.prolog());
	},
	id: function(){return this.__id;},
	context: function(){return this.__context;},
	codeGenerator: function(){return this.__code;},
	handleArgument: function(e){
		var pos = this.__argumentsCount++;
		var isVarArg = false;
		var convert;
		if (this.__type){
			var expectedArguments = this.__type.arguments();
			if (pos >= expectedArguments.length )
				// ignore, handle error after parsing all arguments
				return;
			
			var arg = this.checkArgument(pos, e);
			isVarArg = arg.isVar;
			convert = arg.convert;
		}

		e = isVarArg ? e.ref() : e.deref();
        var code = (convert ? convert(this.__context, e) : e).code();
		var prefix = pos ? ", " : "";
		this.writeCode(prefix + code);
	},
	end: function(){
		if (this.__type)
			this.checkArgumentsCount(this.__argumentsCount);
        return this.callExpression();
    },
    callExpression: function(){
		this.writeCode(this.epilog());
		return new Code.Expression(this.codeGenerator().result(),
                                   this.__type ? this.__type.result() : undefined);
	},
	prolog: function(){return this.__id + "(";},
	checkArgumentsCount: function(count){
		var procArgs = this.__type.arguments();
		if (count != procArgs.length)
			throw new Errors.Error(procArgs.length + " argument(s) expected, got "
								 + this.__argumentsCount);
	},
	checkArgument: function(pos, e){
		var arg = this.__type.arguments()[pos];
		var castOperation;
		var expectType = arg.type; // can be undefined for predefined functions (like NEW), dont check it in this case
		if (expectType){
            var type = e.type();
            castOperation = Cast.implicit(type, expectType);
            if (!castOperation)
				throw new Errors.Error("type mismatch for argument " + (pos + 1) + ": '" + type.description()
                                     + "' cannot be converted to '" + expectType.description() + "'");
        }
		if (arg.isVar){
            var designator = e.designator();
			if (!designator)
				throw new Errors.Error("expression cannot be used as VAR parameter");
			var info = designator.info();
			if (info instanceof Type.Const)
				throw new Errors.Error("constant cannot be used as VAR parameter");
			if (info.isReadOnly())
				throw new Errors.Error("read-only variable cannot be used as VAR parameter");
		}
		return new CheckArgumentResult(arg.type, arg.isVar, castOperation);
	},
	epilog: function(){return ")";},
	writeCode: function(s){this.codeGenerator().write(s);}
});

var ProcType = Type.Basic.extend({
	init: function ProcType(name, args, result, callGeneratorFactory){
		Type.Basic.prototype.init.bind(this)(name, "null");
		this.__arguments = args;
		this.__result = result;
		this.__callGeneratorFactory = callGeneratorFactory
			? callGeneratorFactory
			: function(context, id, type){
				return new ProcCallGenerator(context, id, type);
			};
	},
	isProcedure: function(){return true;},
	define: function(args, result){
		this.__arguments = args;
		this.__result = result;
	},
	arguments: function(){return this.__arguments;},
	result: function(){return this.__result;},
	description: function(){
		var name = this.name();
		if (name)
			return name;
		return 'PROCEDURE' + this.__dumpProcArgs()
			+ (this.__result ? ": " + this.__result.name() : "");
		},
	callGenerator: function(context, id){
		return this.__callGeneratorFactory(context, id, this);
	},
	__dumpProcArgs: function(){
		if (!this.__arguments.length)
			return this.__result ? "()" : "";
		
		var result = "(";
		for(var i = 0; i < this.__arguments.length; ++i){
			if (i)
				result += ", ";
			result += this.__arguments[i].description();
		}
		result += ")";
		return result;
	}
});

var TwoArgToOperatorProcCallGenerator = ProcCallGenerator.extend({
	init: function TwoArgToOperatorProcCallGenerator(context, id, type, operator){
		ProcCallGenerator.prototype.init.call(this, context, id, type);
		this.__operator = operator;
		this.__firstArgument = undefined;
		this.__secondArgument = undefined;
	},
	prolog: function(id){return "";},
	handleArgument: function(e){
		if (!this.__firstArgument)
			this.__firstArgument = e;
		else
			this.__secondArgument = e;
		ProcCallGenerator.prototype.handleArgument.call(this, e);
	},
	epilog: function(type){return "";},
	end: function(){
		return this.__operator(this.__firstArgument, this.__secondArgument);
	}
});

exports.predefined = [
	function(){
		var NewProcCallGenerator = ProcCallGenerator.extend({
			init: function NewProcCallGenerator(context, id, type){
				ProcCallGenerator.prototype.init.call(this, context, id, type);
				this.__baseType = undefined;
			},
			prolog: function(id){return "";},
			checkArgument: function(pos, e){
				ProcCallGenerator.prototype.checkArgument.call(this, pos, e);

                var type = e.type();
				if (!(type instanceof Type.Pointer))
					throw new Errors.Error("POINTER variable expected, got '"
										 + type.name() + "'");
				this.__baseType = type.baseType();
				return new CheckArgumentResult(type, false);
			},
			epilog: function(){return " = new " + this.__baseType.name() + "()";}
		});

		var name = "NEW";
		var args = [new Arg(undefined, true)];
		var type = new Type.Procedure(new ProcType(
			"predefined procedure NEW",
			args,
			undefined,
			function(context, id, type){
				return new NewProcCallGenerator(context, id, type);
			}));
		var symbol = new Type.Symbol(name, type);
		return symbol;
	}(),
	function(){
		var LenProcCallGenerator = ProcCallGenerator.extend({
			init: function LenProcCallGenerator(context, id, type){
				ProcCallGenerator.prototype.init.call(this, context, id, type);
			},
			prolog: function(id){return "";},
			checkArgument: function(pos, e){
                var type = e.type();
				if (type instanceof Type.Array || type instanceof Type.String)
                    return new CheckArgumentResult(type, false);
                
                // should throw error
                ProcCallGenerator.prototype.checkArgument.call(this, pos, e);
			},
			epilog: function(){return ".length";}
		});

		var name = "LEN";
		var args = [new Arg(new Type.Array("ARRAY OF any type"), false)];
		var type = new Type.Procedure(new ProcType(
			"predefined procedure LEN",
			args,
			Type.basic.int,
			function(context, id, type){
				return new LenProcCallGenerator(context, id, type);
			}));
		var symbol = new Type.Symbol(name, type);
		return symbol;
	}(),
    function(){
        var CallGenerator = ProcCallGenerator.extend({
            init: function OddProcCallGenerator(context, id, type){
                ProcCallGenerator.prototype.init.call(this, context, id, type);
            },
            prolog: function(){return "(";},
            epilog: function(){return " & 1)";}
        });
        var name = "ODD";
        var args = [new Arg(Type.basic.int, false)];
        var type = new Type.Procedure(new ProcType(
            "predefined procedure ODD",
            args,
            Type.basic.bool,
            function(context, id, type){
                return new CallGenerator(context, id, type);
            }));
        var symbol = new Type.Symbol(name, type);
        return symbol;
    }(),
	function(){
		var AssertProcCallGenerator = ProcCallGenerator.extend({
			init: function AssertProcCallGenerator(context, id, type){
				ProcCallGenerator.prototype.init.call(this, context, id, type);
			},
			prolog: function(){return this.context().rtl().assertId() + "(";},
			checkArgumentsCount: function(count){
				if (count != 1 && count != 2 )
					throw new Errors.Error("1 or 2 arguments expected, got " + this.__argumentsCount);
			}
		});

		var args = [new Arg(Type.basic.bool), new Arg(Type.basic.int)];
		var proc = new ProcType(
			"predefined procedure ASSERT",
			args,
			undefined,
			function(context, id, type){
				return new AssertProcCallGenerator(context, id, type);
			});
		var type = new Type.Procedure(proc);
		var symbol = new Type.Symbol("ASSERT", type);
		return symbol;
	}(),
	function(){
		var args = [new Arg(Type.basic.set, true),
					new Arg(Type.basic.int, false)];
		function operator(x, y){
            var code = Code.adjustPrecedence(x, precedence.assignment) +
                       " |= 1 << " +
                       Code.adjustPrecedence(y, precedence.shift);
            return new Code.Expression(
                code, Type.basic.set, undefined, undefined, precedence.assignment);
        }
		var proc = new ProcType(
			"predefined procedure INCL",
			args,
			undefined,
			function(context, id, type){
				return new TwoArgToOperatorProcCallGenerator(
					context, id, type, operator);
				});
		var type = new Type.Procedure(proc);
		var symbol = new Type.Symbol("INCL", type);
		return symbol;
	}(),
	function(){
		var args = [new Arg(Type.basic.set, true),
					new Arg(Type.basic.int, false)];
		function operator(x, y){
            var code = Code.adjustPrecedence(x, precedence.assignment) +
                       " &= ~(1 << " +
                       Code.adjustPrecedence(y, precedence.shift) +
                       ")";
            return new Code.Expression(
                code, Type.basic.set, undefined, undefined, precedence.assignment);
        }
		var proc = new ProcType(
			"predefined procedure EXCL",
			args,
			undefined,
			function(context, id, type){
				return new TwoArgToOperatorProcCallGenerator(
					context, id, type, operator);
				});
		var type = new Type.Procedure(proc);
		var symbol = new Type.Symbol("EXCL", type);
		return symbol;
	}(),
    function(){
        var CallGenerator = ProcCallGenerator.extend({
            init: function OrdProcCallGenerator(context, id, type){
                ProcCallGenerator.prototype.init.call(this, context, id, type);
                this.__callExpression = undefined;
            },
            prolog: function(){return "";},
            epilog: function(){return "";},
            checkArgument: function(pos, e){
                var type = e.type();
                if (type == Type.basic.char || type == Type.basic.set)
                    this.__callExpression = new Code.Expression(e.code(), Type.basic.int, undefined, e.constValue());
                else if (type == Type.basic.bool){
                    var code = Code.adjustPrecedence(e, precedence.conditional) + " ? 1 : 0";
                    var value = e.constValue();
                    if (value !== undefined)
                        value = value ? 1 : 0;
                    this.__callExpression = new Code.Expression(code, Type.basic.int, undefined, value, precedence.conditional);
                }
                else if (type instanceof Type.String){
                    var ch = type.asChar();
                    if (ch !== undefined)
                        this.__callExpression = new Code.Expression("" + ch, Type.basic.int);
                }
                
                if (this.__callExpression)
                    return new CheckArgumentResult(type, false);

                // should throw error
                ProcCallGenerator.prototype.checkArgument.call(this, pos, e);
            },
            callExpression: function(){return this.__callExpression;}
        });
        var name = "ORD";
        var argType = new Type.Basic("CHAR or BOOLEAN or SET");
        var args = [new Arg(argType, false)];
        var type = new Type.Procedure(new ProcType(
            "predefined procedure " + name,
            args,
            Type.basic.int,
            function(context, id, type){
                return new CallGenerator(context, id, type);
            }));
        var symbol = new Type.Symbol(name, type);
        return symbol;
    }(),
    function(){
        var CallGenerator = ProcCallGenerator.extend({
            init: function ChrProcCallGenerator(context, id, type){
                ProcCallGenerator.prototype.init.call(this, context, id, type);
                this.__callExpression = undefined;
            },
            prolog: function(){return "";},
            epilog: function(){return "";},
            checkArgument: function(pos, e){
                this.__callExpression = new Code.Expression(e.code(), Type.basic.char);
                return ProcCallGenerator.prototype.checkArgument.call(this, pos, e);
            },
            callExpression: function(){return this.__callExpression;}
        });
        var name = "CHR";
        var type = new Type.Procedure(new ProcType(
            "predefined procedure " + name,
            [new Arg(Type.basic.int, false)],
            Type.basic.char,
            function(context, id, type){
                return new CallGenerator(context, id, type);
            }));
        var symbol = new Type.Symbol(name, type);
        return symbol;
    }()
	];

exports.CallGenerator = ProcCallGenerator;
exports.Type = ProcType;