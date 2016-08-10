// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require) {
  var Backbone = require('backbone');
  var Origin = require('coreJS/app/origin');
  var EditorOriginView = require('editorGlobal/views/editorOriginView');

  var EditorComponentEditView = EditorOriginView.extend({
    tagName: "div",
    className: "component-edit",

    preRender: function() {
      this.listenTo(Origin, 'editorComponentEditSidebar:views:save', this.save);
      this.model.set('ancestors', this.model.getPossibleAncestors().toJSON());
    },

    cancel: function (event) {
      event.preventDefault();
      Origin.trigger('editorSidebarView:removeEditView', this.model);
    },

    getAttributesToSave: function() {
      self.model.set('_componentType', self.model.get('_componentType')._id);
      return EditorOriginView.prototype.getAttributesToSave.apply(this, arguments);
    },

    onSaveError: function() {
      Origin.trigger('editor:refreshData', function() {
        var currentPageId = this.model.getParent().getParent().getParent().get('_id');
        var currentCourseId = Origin.editor.data.course.get('_id');
        Origin.router.navigate('#/editor/' + currentCourseId + '/page/' + currentPageId);
        this.remove();
      }, this);
    },
  },
  {
    template: 'editorComponentEdit'
  });

  return EditorComponentEditView;
});
