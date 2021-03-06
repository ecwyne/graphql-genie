
import { GraphQLBoolean, GraphQLEnumType, GraphQLField, GraphQLInputFieldConfigMap, GraphQLInputObjectType, GraphQLInputType, GraphQLList, GraphQLNamedType, GraphQLNonNull, GraphQLScalarType, GraphQLSchema, IntrospectionField, IntrospectionObjectType, IntrospectionType, getNamedType, getNullableType, isEnumType, isInputType, isInterfaceType, isListType, isNonNullType, isObjectType, isScalarType, isUnionType } from 'graphql';
import { camelCase, each, get, isEmpty, merge } from 'lodash';
import pluralize from 'pluralize';
import { GenerateConfig } from './GraphQLGenieInterfaces';
import { getReturnType, typeIsList } from './GraphQLUtils';
import { Mutation, Relations, capFirst, fortuneFilters } from './TypeGeneratorUtilities';
export class InputGenerator {

	private type: GraphQLNamedType;
	private config: GenerateConfig;
	private currInputObjectTypes: Map<string, GraphQLInputType>;
	private schemaInfo: IntrospectionType[];
	private schema: GraphQLSchema;
	private relations: Relations;
	private nestedGenerators: Map<string, {'function': () => GraphQLInputType, 'args': Array<any>, 'this': InputGenerator}>;
	private dummy: boolean;

	constructor($type: GraphQLNamedType, $config: GenerateConfig, $currInputObjectTypes: Map<string, GraphQLInputType>,
		 $schemaInfo: IntrospectionType[], $schema: GraphQLSchema, $relations: Relations, $dummy = false) {
		this.type = $type;
		this.config = $config;
		this.currInputObjectTypes = $currInputObjectTypes;
		this.schemaInfo = $schemaInfo;
		this.schema = $schema;
		this.relations = $relations;
		this.nestedGenerators = new Map<string, {'function': () => GraphQLInputType, 'args': Array<any>, 'this': InputGenerator}>();
		this.dummy = $dummy;
	}

	private handleNestedGenerators() {
		this.nestedGenerators.forEach((generator) => {
			if (generator.function) {
				generator.function.apply(generator.this, generator.args);
			}
			generator.function = null;
		});
	}

	private generateInputTypeForField(field: GraphQLField<any, any, {[argName: string]: any; }>,
		manyWithout: (fieldType: GraphQLNamedType, relationFieldName: string) => GraphQLInputType,
		oneWithout: (fieldType: GraphQLNamedType, relationFieldName: string) => GraphQLInputType,
		many: (fieldType: GraphQLNamedType) => GraphQLInputType,
		one: (fieldType: GraphQLNamedType) => GraphQLInputType
	): GraphQLInputType {
		let inputType: GraphQLInputType;
		const fieldType = getNamedType(field.type);
		const relationFieldName = this.relations.getInverseWithoutName(fieldType.name, field.name);
		const isList = typeIsList(field.type);
		// tslint:disable-next-line:prefer-conditional-expression
		if (relationFieldName) {
			inputType = isList ? manyWithout.call(this, fieldType, relationFieldName) : oneWithout.call(this, fieldType, relationFieldName);
		} else {
			inputType = isList ? many.call(this, fieldType) : one.call(this, fieldType);
		}
		return inputType;
	}

	private isAutomaticField(field: IntrospectionField): boolean {
		let isAutoField = false;
		if (field) {
			if (field.name === 'id') {
				isAutoField = true;
			} else if (get(field, 'metadata.updatedTimestamp') === true) {
				isAutoField = true;
			} else if (get(field, 'metadata.createdTimestamp') === true) {
				isAutoField = true;
			}
		}
		return isAutoField;
	}

	private generateInputTypeForFieldInfo(field: IntrospectionField, mutation: Mutation): GraphQLInputType {
		let inputType: GraphQLInputType;
		const fieldTypeName = getReturnType(field.type);
		const schemaType = this.schema.getType(fieldTypeName);
		if (isInputType(schemaType)) {
			if (mutation === Mutation.Update && !this.isAutomaticField(field)) {
				const nullableType = getNullableType(schemaType);
				const namedType = getNamedType(schemaType);
				// tslint:disable-next-line:prefer-conditional-expression
				if (typeIsList(field.type) && (isScalarType(namedType) || isEnumType(namedType))) {
					inputType = this.getScalarListInput(namedType);
				} else {
					inputType = nullableType;
				}
			} else {
				inputType = schemaType;
			}
		} else {
			const isArray = typeIsList(field.type);
			let fieldInputName = schemaType.name;
			let fieldSuffix = Mutation[mutation];
			fieldSuffix += isArray ? 'Many' : 'One';

			const relationFieldName = this.relations.getInverseWithoutName(fieldTypeName, field.name);
			fieldSuffix += relationFieldName ? 'Without'  : '';
			fieldInputName += fieldSuffix + capFirst(relationFieldName) + 'Input';
			if (isInterfaceType(schemaType) || isUnionType(schemaType)) {
				if (this.currInputObjectTypes.has(fieldInputName)) {
					inputType = this.currInputObjectTypes.get(fieldInputName);
				} else {
					const fields = {};
					const possibleTypes = this.schemaInfo[fieldTypeName]['possibleTypes'];
					possibleTypes.forEach(typeInfo => {
						const typeName = isArray ? pluralize(typeInfo.name) : typeInfo.name;
						const fieldName = camelCase(typeName);
						const fieldInputTypeName = typeInfo.name + fieldSuffix + capFirst(relationFieldName) + 'Input';
						merge(fields, this.generateFieldForInput(
							fieldName,
							new GraphQLInputObjectType({name: fieldInputTypeName, fields: {}})));

						const functionName = `generate${fieldSuffix}Input`;
						if (!this.dummy && !this.nestedGenerators.has(fieldInputTypeName)) {
							const possibleSchemaType = getNamedType(this.schema.getType(typeInfo.name));
							const possibleTypeGenerator = new InputGenerator(possibleSchemaType, this.config, this.currInputObjectTypes, this.schemaInfo, this.schema, this.relations, true);
							this.nestedGenerators.set(fieldInputTypeName, {
								'function': possibleTypeGenerator[functionName],
								'args': [possibleSchemaType, relationFieldName],
								'this': possibleTypeGenerator
							});
						}
					});
					const newInputObject = new GraphQLInputObjectType({
						name: fieldInputName,
						fields
					});
					if (!this.dummy) {
						this.currInputObjectTypes.set(fieldInputName, newInputObject);
					}
					inputType = newInputObject;
				}
			} else {
				if (!this.dummy) {
					const typeGenerator = new InputGenerator(schemaType, this.config, this.currInputObjectTypes, this.schemaInfo, this.schema, this.relations, true);
					const functionName = `generate${fieldSuffix}Input`;
					inputType = typeGenerator[functionName].apply(typeGenerator, [schemaType, relationFieldName]);
				} else {
					inputType = new GraphQLInputObjectType({name: fieldInputName, fields: {}});
				}
			}
		}
		if (!this.dummy) {
			this.handleNestedGenerators();
		}

		return inputType;
	}

	private generateFieldForInput = (fieldName: string, inputType: GraphQLInputType, defaultValue?: string): object => {
		const field = {};
		field[fieldName] = {
			type: inputType,
			defaultValue: defaultValue
		};
		return field;
	}

	generateWhereUniqueInput(fieldType: GraphQLNamedType = this.type): GraphQLInputObjectType {
		const name = fieldType.name + 'WhereUniqueInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			const infoType = <IntrospectionObjectType>this.schemaInfo[fieldType.name];
			infoType.fields.forEach(field => {
				if (get(field, 'metadata.unique') === true) {
					const isArray = typeIsList(field.type);
					const schemaType = this.schema.getType(getReturnType(field.type));
					let inputType;
					if (isInputType(schemaType)) {
						inputType = schemaType;
					} else {
						const fieldInputName = schemaType.name + 'WhereUniqueInput';
						inputType = new GraphQLInputObjectType({name: fieldInputName, fields: {}});
					}
					if (isArray) {
						inputType = new GraphQLList(inputType);
					}
					merge(fields, this.generateFieldForInput(
						field.name,
						inputType,
						get(field, 'metadata.defaultValue')));
				}
			});

			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return <GraphQLInputObjectType>this.currInputObjectTypes.get(name);
	}

	private getWhereInput(typeName: string, fields: GraphQLInputFieldConfigMap, existsFields: GraphQLInputFieldConfigMap, matchFields: GraphQLInputFieldConfigMap, rangeFields: GraphQLInputFieldConfigMap, addLogicalOperators: boolean): GraphQLInputType {
		const name = typeName + 'WhereInput';
		const existsName = typeName + 'ExistsInput';
		const matchName = typeName + 'MatchInput';
		const rangeName = typeName + 'RangeInput';
		const existsInput = new GraphQLInputObjectType({
			name: existsName,
			description: 'Specifies if a field should exist or not (true or false)',
			fields: existsFields
		});
		const matchInput = new GraphQLInputObjectType({
			name: matchName,
			description: 'Match the supplied values for each field',
			fields: matchFields
		});
		const rangeInput = new GraphQLInputObjectType({
			name: rangeName,
			description: 'Filter between lower and upper bounds, takes precedence over match',
			fields: rangeFields
		});
		this.currInputObjectTypes.set(existsName, existsInput);
		this.currInputObjectTypes.set(matchName, matchInput);
		this.currInputObjectTypes.set(rangeName, rangeInput);
		merge(fields, {
			exists: {type: existsInput},
			match: {type: matchInput},
			range: {type: rangeInput}
		});

		if (addLogicalOperators) {
			const dummyListOfFilterInput = new GraphQLInputObjectType({name, fields: {}});
			merge(fields, {
				and: {type: new GraphQLList(new GraphQLNonNull(dummyListOfFilterInput))},
				or: {type: new GraphQLList(new GraphQLNonNull(dummyListOfFilterInput))},
				not: {type: dummyListOfFilterInput}
			});
		}

		this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
			name,
			fields
		}));
		return this.currInputObjectTypes.get(name);
	}

	generateWhereInput(addLogicalOperators: boolean, fieldType: GraphQLNamedType = this.type, ): GraphQLInputType {
		const name = fieldType.name + 'WhereInput';
		if (!this.currInputObjectTypes.has(name)) {
			const existsFields = {};
			const matchFields = {};
			const rangeFields = {};
			const fields = {};
			const infoType = <IntrospectionObjectType>this.schemaInfo[fieldType.name];
			infoType.fields.forEach(field => {
					const schemaType = this.schema.getType(getReturnType(field.type));

					merge(existsFields, this.generateFieldForInput(
						field.name,
						GraphQLBoolean));

					let inputType;
					if (isInputType(schemaType)) {
						inputType = getNamedType(schemaType);

						merge(matchFields, this.generateFieldForInput(
							field.name,
							new GraphQLList(new GraphQLNonNull(inputType))));

						merge(rangeFields, this.generateFieldForInput(
							field.name,
							new GraphQLList(inputType)));
					} else {
						const fieldInputName = schemaType.name + 'WhereInput';
						let fieldName = field.name;
						if (!this.currInputObjectTypes.has(fieldInputName) && !this.dummy && (isInterfaceType(schemaType) || isUnionType(schemaType))) {
							const interfaceExistsFields = {};
							const interfaceMatchFields = {};
							const interfaceRangeFields = {};
							const interfaceFields = {};
							const possibleTypes: IntrospectionObjectType[] = this.schemaInfo[schemaType.name].possibleTypes;
							possibleTypes.forEach(typeInfo => {
								const possibleSchemaType = getNamedType(this.schema.getType(typeInfo.name));
								const possibleTypeGenerator = new InputGenerator(possibleSchemaType, this.config, this.currInputObjectTypes, this.schemaInfo, this.schema, this.relations, true);
								const possibleTypeFilter = possibleTypeGenerator.generateWhereInput(addLogicalOperators);
								const possibleTypeFieldMap = (<GraphQLInputObjectType>possibleTypeFilter).getFields();
								merge(interfaceFields, possibleTypeFieldMap);
								merge(interfaceExistsFields, (<GraphQLInputObjectType>possibleTypeFieldMap['exists'].type).getFields());
								merge(interfaceMatchFields, (<GraphQLInputObjectType>possibleTypeFieldMap['match'].type).getFields());
								merge(interfaceRangeFields, (<GraphQLInputObjectType>possibleTypeFieldMap['range'].type).getFields());

							});

							inputType = this.getWhereInput(schemaType.name, interfaceFields, interfaceExistsFields, interfaceMatchFields, interfaceRangeFields, addLogicalOperators);
						} else {
							inputType = new GraphQLInputObjectType({name: fieldInputName, fields: {}});
							if (fortuneFilters.includes(fieldName)) {
								fieldName = 'f_' + fieldName;
							}
						}
						merge(fields, this.generateFieldForInput(
							fieldName,
							inputType));
					}
			});
			this.getWhereInput(fieldType.name, fields, existsFields, matchFields, rangeFields, addLogicalOperators);
		}
		return this.currInputObjectTypes.get(name);
	}

	generateOrderByInput(fieldType: GraphQLNamedType = this.type): GraphQLInputType {
		const name = fieldType.name + 'OrderByInput';
		if (!this.currInputObjectTypes.has(name)) {
			const orderByEnum = <GraphQLEnumType>this.schema.getType('ORDER_BY_OPTIONS');
			const fields = {};
			const infoType = <IntrospectionObjectType>this.schemaInfo[fieldType.name];
			infoType.fields.forEach(field => {
					const schemaType = this.schema.getType(getReturnType(field.type));

					let inputType;
					if (isInputType(schemaType)) {
						inputType = getNamedType(schemaType);
						merge(fields, this.generateFieldForInput(
							field.name,
							orderByEnum
						));

					} else {
						const fieldInputName = schemaType.name + 'OrderByInput';
						if (!this.currInputObjectTypes.has(fieldInputName) && !this.dummy && (isInterfaceType(schemaType) || isUnionType(schemaType))) {
							const interfaceFields = {};
							const possibleTypes: IntrospectionObjectType[] = this.schemaInfo[schemaType.name].possibleTypes;
							possibleTypes.forEach(typeInfo => {
								const possibleSchemaType = getNamedType(this.schema.getType(typeInfo.name));
								const possibleTypeGenerator = new InputGenerator(possibleSchemaType, this.config, this.currInputObjectTypes, this.schemaInfo, this.schema, this.relations, true);
								const possibleTypeFilter = possibleTypeGenerator.generateOrderByInput();
								const possibleTypeFieldMap = (<GraphQLInputObjectType>possibleTypeFilter).getFields();
								merge(interfaceFields, possibleTypeFieldMap);
							});
							inputType = new GraphQLInputObjectType({
								name: fieldInputName,
								fields: interfaceFields
							});
							this.currInputObjectTypes.set(fieldInputName, inputType);
						} else {
							inputType = new GraphQLInputObjectType({name: fieldInputName, fields: {}});
						}
						merge(fields, this.generateFieldForInput(
							field.name,
							inputType));
					}
			});
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateWithoutInput(fieldType: GraphQLNamedType = this.type, relationFieldName?: string): GraphQLInputType {

		let name = fieldType.name + 'Create';
		name += relationFieldName ? 'Without' + capFirst(relationFieldName) : '';
		name += 'Input';
		if (!relationFieldName) {
			return new GraphQLInputObjectType({name, fields: {}});
		}
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			const infoType = <IntrospectionObjectType>this.schemaInfo[fieldType.name];
			infoType.fields.forEach(field => {
				if (!this.isAutomaticField(field) && field.name !== relationFieldName) {
					let inputType = this.generateInputTypeForFieldInfo(field, Mutation.Create);
					if (field.type.kind === 'NON_NULL' && field.type.ofType.kind !== 'LIST') {
						inputType = new GraphQLNonNull(inputType);
					}

					merge(fields, this.generateFieldForInput(
						field.name,
						inputType,
						get(field, 'metadata.defaultValue')));
				}
			});

			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateManyWithoutInput(fieldType: GraphQLNamedType  = this.type, relationFieldName: string): GraphQLInputType {
		const name = fieldType.name + 'CreateManyWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: new GraphQLList(new GraphQLNonNull(this.generateCreateWithoutInput(fieldType, relationFieldName)))};
			fields['connect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateOneWithoutInput(fieldType: GraphQLNamedType, relationFieldName: string): GraphQLInputType {
		const name = fieldType.name + 'CreateOneWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: this.generateCreateWithoutInput(fieldType, relationFieldName)};
			fields['connect'] = {type: this.generateWhereUniqueInput(fieldType)};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateManyInput(fieldType: GraphQLNamedType): GraphQLInputType {
		const name = fieldType.name + 'CreateManyInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: new GraphQLList(new GraphQLNonNull(this.generateCreateWithoutInput(fieldType)))};
			fields['connect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateOneInput(fieldType: GraphQLNamedType): GraphQLInputType {
		const name = fieldType.name + 'CreateOneInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: this.generateCreateWithoutInput(fieldType)};
			fields['connect'] = {type: this.generateWhereUniqueInput(fieldType)};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateCreateInput(): GraphQLInputType {
		const name = this.type.name + 'CreateInput';
		const infoType = this.schemaInfo[this.type.name];
		const fields = {};
		if (isObjectType(this.type) && !this.currInputObjectTypes.has(name)) {
			const infoTypeFields: IntrospectionField[] = infoType.fields;
			each(this.type.getFields(), field => {
				if (field.name !== 'id') {
					let inputType;
					const fieldNullableType = getNullableType(field.type);
					if (isInputType(field.type)) {
						const infoTypeField = infoTypeFields.find(infoTypeField => infoTypeField.name === field.name);
						if (!this.isAutomaticField(infoTypeField)) {
							inputType = isListType(fieldNullableType) ? fieldNullableType : field.type;
						}
					} else if (isObjectType(field.type)) {
						inputType = this.generateInputTypeForField(field, this.generateCreateManyWithoutInput,
							this.generateCreateOneWithoutInput,
							this.generateCreateManyInput,
							this.generateCreateOneInput);
					} else {
						inputType = this.generateInputTypeForFieldInfo(
							infoTypeFields.find(currField => currField.name === field.name),
						 	Mutation.Create);
					}
					if (inputType && !isListType(fieldNullableType) && isNonNullType(field.type) && !isNonNullType(inputType)) {
						inputType = new GraphQLNonNull(inputType);
					}
					if (inputType) {
						merge(fields, this.generateFieldForInput(
							field.name,
							inputType,
							get(this.schemaInfo[this.type.name].fields.find((introField) => introField.name === field.name), 'metadata.defaultValue')));
					}
				}
			});
			if (isEmpty(fields)) {
				throw new Error(`Types must have at least one field other than ID, ${this.type.name} does not`);
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));

		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateWithoutInput(fieldType: GraphQLNamedType, relationFieldName?: string): GraphQLInputType {

		let name = fieldType.name + 'Update';
		name += relationFieldName ? 'Without' + capFirst(relationFieldName) : '';
		name += 'Input';
		if (!relationFieldName) {
			return new GraphQLInputObjectType({name, fields: {}});
		}
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			const infoType = <IntrospectionObjectType>this.schemaInfo[fieldType.name];
			infoType.fields.forEach(field => {
				if (!this.isAutomaticField(field) && field.name !== relationFieldName) {
					const inputType = this.generateInputTypeForFieldInfo(field, Mutation.Update);
					merge(fields, this.generateFieldForInput(
						field.name,
						inputType));
				}
			});

			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateWithWhereUniqueWithoutInput(fieldType: GraphQLNamedType, relationFieldName?: string): GraphQLInputType {
		const name = fieldType.name + 'UpdateWithWhereUniqueWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['data'] = {type: new GraphQLNonNull(this.generateUpdateWithoutInput(fieldType, relationFieldName))};
			fields['where'] = {type: new GraphQLNonNull(this.generateWhereUniqueInput(fieldType))};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateManyWithoutInput(fieldType: GraphQLNamedType, relationFieldName: string): GraphQLInputType {
		const name = fieldType.name + 'UpdateManyWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: new GraphQLList(new GraphQLNonNull(this.generateCreateWithoutInput(fieldType, relationFieldName)))};
			fields['connect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['disconnect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['delete'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['update'] = {type: new GraphQLList(new GraphQLNonNull(this.generateUpdateWithWhereUniqueWithoutInput(fieldType, relationFieldName)))};
			if (this.config.generateUpsert) {
				fields['upsert'] = {type: new GraphQLList(new GraphQLNonNull(this.generateUpsertWithWhereUniqueWithoutInput(fieldType, relationFieldName)))};
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateOneWithoutInput(fieldType: GraphQLNamedType, relationFieldName: string): GraphQLInputType {
		const name = fieldType.name + 'UpdateOneWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: this.generateCreateWithoutInput(fieldType, relationFieldName)};
			fields['connect'] = {type: this.generateWhereUniqueInput(fieldType)};
			fields['disconnect'] = {type: GraphQLBoolean};
			fields['delete'] = {type: GraphQLBoolean};
			fields['update'] = {type: this.generateUpdateWithoutInput(fieldType, relationFieldName)};
			if (this.config.generateUpsert) {
				fields['upsert'] = {type: this.generateUpsertWithoutInput(fieldType, relationFieldName)};
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateManyInput(fieldType: GraphQLNamedType): GraphQLInputType {
		const name = fieldType.name + 'UpdateManyInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: new GraphQLList(new GraphQLNonNull(this.generateCreateWithoutInput(fieldType)))};
			fields['connect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['disconnect'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['delete'] = {type: new GraphQLList(new GraphQLNonNull(this.generateWhereUniqueInput(fieldType)))};
			fields['update'] = {type: new GraphQLList(new GraphQLNonNull(this.generateUpdateWithWhereUniqueWithoutInput(fieldType)))};
			if (this.config.generateUpsert) {
				fields['upsert'] = {type: new GraphQLList(new GraphQLNonNull(this.generateUpsertWithWhereUniqueWithoutInput(fieldType)))};
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateOneInput(fieldType: GraphQLNamedType): GraphQLInputType {
		const name = fieldType.name + 'UpdateOneInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['create'] = {type: this.generateCreateWithoutInput(fieldType)};
			fields['connect'] = {type: this.generateWhereUniqueInput(fieldType)};
			fields['disconnect'] = {type: GraphQLBoolean};
			fields['delete'] = {type: GraphQLBoolean};
			fields['update'] = {type: this.generateUpdateWithoutInput(fieldType)};
			if (this.config.generateUpsert) {
				fields['upsert'] = {type: this.generateUpsertWithoutInput(fieldType)};
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpdateInput(): GraphQLInputType {
		const name = this.type.name + 'UpdateInput';
		const fields = {};
		if (isObjectType(this.type) && !this.currInputObjectTypes.has(name)) {
			const infoTypeFields: IntrospectionField[] = this.schemaInfo[this.type.name].fields;

			each(this.type.getFields(), field => {
				if (field.name !== 'id') {
					let inputType;
					if (isInputType(field.type)) {
						const infoTypeField = infoTypeFields.find(infoTypeField => infoTypeField.name === field.name);
						if (!this.isAutomaticField(infoTypeField)) {
							const nullableType = getNullableType(field.type);
							const namedType = getNamedType(field.type);
							// tslint:disable-next-line:prefer-conditional-expression
							if (isListType(nullableType) && (isScalarType(namedType) || isEnumType(namedType))) {
								inputType = this.getScalarListInput(namedType);
							} else {
								inputType = nullableType;
							}
						}
					} else if (isObjectType(field.type)) {
						inputType = this.generateInputTypeForField(field, this.generateUpdateManyWithoutInput,
							this.generateUpdateOneWithoutInput,
							this.generateUpdateManyInput,
							this.generateUpdateOneInput);
					} else {
						inputType = this.generateInputTypeForFieldInfo(
							infoTypeFields.find(currField => currField.name === field.name),
						 	Mutation.Update);
					}
					if (inputType) {
						merge(fields, this.generateFieldForInput(
							field.name,
							inputType));
					}
				}
			});
			if (isEmpty(fields)) {
				throw new Error(`Types must have at least one field other than ID, ${this.type.name} does not`);
			}
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));

		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpsertWithoutInput(fieldType: GraphQLNamedType, relationFieldName?: string): GraphQLInputType {

		let name = fieldType.name + 'Upsert';
		name += relationFieldName ? 'Without' + capFirst(relationFieldName) : '';
		name += 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['update'] = {type: new GraphQLNonNull(this.generateUpdateWithoutInput(fieldType, relationFieldName))};
			fields['create'] = {type: new GraphQLNonNull(this.generateCreateWithoutInput(fieldType, relationFieldName))};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	generateUpsertWithWhereUniqueWithoutInput(fieldType: GraphQLNamedType, relationFieldName?: string): GraphQLInputType {
		const name = fieldType.name + 'UpsertWithWhereUniqueWithout' + capFirst(relationFieldName) + 'Input';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['update'] = {type: new GraphQLNonNull(this.generateUpdateWithoutInput(fieldType, relationFieldName))};
			fields['create'] = {type: new GraphQLNonNull(this.generateCreateWithoutInput(fieldType, relationFieldName))};
			fields['where'] = {type: new GraphQLNonNull(this.generateWhereUniqueInput(fieldType))};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

	private getScalarListInput(scalarType: GraphQLScalarType | GraphQLEnumType): GraphQLInputType {
		const name = scalarType.name + 'ScalarListInput';
		if (!this.currInputObjectTypes.has(name)) {
			const fields = {};
			fields['set'] = {type: new GraphQLList(scalarType)};
			fields['push'] = {type: new GraphQLList(scalarType)};
			fields['pull'] = {type: new GraphQLList(scalarType)};
			this.currInputObjectTypes.set(name, new GraphQLInputObjectType({
				name,
				fields
			}));
		}
		return this.currInputObjectTypes.get(name);
	}

}
